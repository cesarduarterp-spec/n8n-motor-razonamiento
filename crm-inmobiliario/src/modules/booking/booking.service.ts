import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, gte, lt } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { leads, properties, tenants, users, visits } from '../../database/schema.js';
import { PipelineService } from '../pipeline/pipeline.service.js';
import { GoogleCalendarClient } from './google-calendar.client.js';
import { DEFAULT_SLOT_CONFIG, formatSlot, freeSlots, type Interval, type SlotConfig, spreadPick } from './slots.js';

const HORIZON_DAYS = 7;

export interface SlotOption {
  start: string; // ISO UTC
  label: string; // "jueves 16/10 10:30"
}

/**
 * Booker agéntico: calcula disponibilidad real del asesor (Google Calendar
 * + visitas ya agendadas) y reserva de forma atómica. La restricción EXCLUDE
 * de `visits` es la última línea de defensa contra la doble reserva cuando
 * dos conversaciones eligen el mismo turno a la vez.
 */
@Injectable()
export class BookingService {
  private readonly log = new Logger(BookingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly calendar: GoogleCalendarClient,
    private readonly pipeline: PipelineService,
  ) {}

  private async context(tenantId: string, leadId: string, propertyRef: { propertyId?: string; propertyCode?: string }) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [tenant] = await tx.select({ settings: tenants.settings, name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
      const [property] = await tx
        .select({ id: properties.id, code: properties.code, title: properties.title, address: properties.address, neighborhood: properties.neighborhood })
        .from(properties)
        .where(propertyRef.propertyId ? eq(properties.id, propertyRef.propertyId) : eq(properties.code, propertyRef.propertyCode ?? ''));
      if (!property) throw new NotFoundException('Propiedad inexistente');

      // Sin asesor asignado → se asigna ahora con las reglas de round-robin.
      const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
      if (!lead) throw new NotFoundException('Lead inexistente');
      const advisorId = lead.assignedUserId ?? (await this.pipeline.assign(tx, tenantId, leadId));
      if (!advisorId) throw new BadRequestException('No hay asesores disponibles para asignar la visita');
      const [advisor] = await tx.select().from(users).where(eq(users.id, advisorId));

      const v = tenant?.settings.visits;
      const config: SlotConfig = {
        ...DEFAULT_SLOT_CONFIG,
        ...(v?.hours ? { hours: v.hours } : {}),
        ...(v?.utcOffset ? { utcOffset: v.utcOffset } : {}),
        ...(v?.durationMin ? { durationMin: v.durationMin } : {}),
        ...(v?.bufferMin !== undefined ? { bufferMin: v.bufferMin } : {}),
      };
      return { property, advisor: advisor!, config };
    });
  }

  private async busy(tenantId: string, advisor: typeof users.$inferSelect, from: Date, to: Date): Promise<Interval[]> {
    const dbBusy = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select({ start: visits.startsAt, end: visits.endsAt })
        .from(visits)
        .where(and(eq(visits.userId, advisor.id), eq(visits.status, 'scheduled'), lt(visits.startsAt, to), gte(visits.endsAt, from))),
    );
    if (!(await this.calendar.hasCalendar(tenantId, advisor.id))) return dbBusy;
    const calBusy = await this.calendar.busy(tenantId, advisor.id, advisor.calendarId ?? 'primary', from, to);
    return [...dbBusy, ...calBusy];
  }

  /** Hasta 6 opciones de horario repartidas en la próxima semana. */
  async availableSlots(tenantId: string, leadId: string, ref: { propertyId?: string; propertyCode?: string }, max = 6): Promise<{
    advisor: string;
    property: string;
    slots: SlotOption[];
  }> {
    const { property, advisor, config } = await this.context(tenantId, leadId, ref);
    const from = new Date();
    const to = new Date(from.getTime() + HORIZON_DAYS * 86_400_000);
    const all = freeSlots({ from, days: HORIZON_DAYS, busy: await this.busy(tenantId, advisor, from, to), config });
    return {
      advisor: advisor.fullName,
      property: `${property.code} – ${property.title}`,
      slots: spreadPick(all, max, config.utcOffset).map((s) => ({ start: s.toISOString(), label: formatSlot(s, config.utcOffset) })),
    };
  }

  /**
   * Reserva: (1) re-verifica que el turno siga libre, (2) inserta la visita
   * (EXCLUDE impide solapamientos), (3) crea el evento en el calendario del
   * asesor; si Google falla, la visita se cancela para no dejar un turno
   * fantasma, (4) avanza el lead a "Visita coordinada".
   */
  async book(
    tenantId: string,
    leadId: string,
    ref: { propertyId?: string; propertyCode?: string },
    startIso: string,
    bookedBy: string,
  ) {
    const { property, advisor, config } = await this.context(tenantId, leadId, ref);
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Horario inválido');
    const end = new Date(start.getTime() + config.durationMin * 60_000);

    const stillFree = freeSlots({
      from: new Date(start.getTime() - 60_000),
      days: 1,
      busy: await this.busy(tenantId, advisor, start, end),
      config,
    }).some((s) => s.getTime() === start.getTime());
    if (!stillFree) throw new ConflictException('Ese horario ya no está disponible');

    const visit = await this.db
      .withTenant(tenantId, async (tx) => {
        const [row] = await tx
          .insert(visits)
          .values({ tenantId, leadId, propertyId: property.id, userId: advisor.id, startsAt: start, endsAt: end, bookedBy })
          .returning();
        await this.pipeline.advanceTo(tx, leadId, 'visit_scheduled');
        return row!;
      })
      .catch((err: unknown) => {
        if (String((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code) === '23P01') {
          throw new ConflictException('Ese horario se acaba de reservar');
        }
        throw err;
      });

    if (await this.calendar.hasCalendar(tenantId, advisor.id)) {
      try {
        const eventId = await this.calendar.createEvent(tenantId, advisor.id, advisor.calendarId ?? 'primary', {
          summary: `Visita ${property.code} – ${property.title}`,
          description: `Visita agendada por ${bookedBy}. Lead ${leadId}.`,
          location: property.address ?? property.neighborhood ?? undefined,
          start,
          end,
          visitId: visit.id,
        });
        await this.db.withTenant(tenantId, (tx) => tx.update(visits).set({ calendarEventId: eventId }).where(eq(visits.id, visit.id)));
      } catch (err) {
        this.log.error(`No se pudo crear el evento de calendario: ${String(err)}`);
        await this.db.withTenant(tenantId, (tx) => tx.update(visits).set({ status: 'cancelled', notes: 'Falló la creación del evento en Google Calendar' }).where(eq(visits.id, visit.id)));
        throw new ConflictException('No se pudo confirmar el turno en la agenda del asesor');
      }
    }

    return {
      visitId: visit.id,
      when: formatSlot(start, config.utcOffset),
      advisor: advisor.fullName,
      property: `${property.code} – ${property.title}`,
    };
  }

  async cancel(tenantId: string, visitId: string, reason: string) {
    const visit = await this.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .update(visits)
        .set({ status: 'cancelled', notes: reason })
        .where(and(eq(visits.id, visitId), eq(visits.status, 'scheduled')))
        .returning();
      return row;
    });
    if (!visit) throw new NotFoundException('Visita inexistente o no vigente');
    if (visit.calendarEventId) {
      const [advisor] = await this.db.withTenant(tenantId, (tx) => tx.select().from(users).where(eq(users.id, visit.userId)));
      await this.calendar
        .deleteEvent(tenantId, visit.userId, advisor?.calendarId ?? 'primary', visit.calendarEventId)
        .catch((err: unknown) => this.log.warn(`No se pudo borrar el evento ${visit.calendarEventId}: ${String(err)}`));
    }
    return { visitId, status: 'cancelled' };
  }
}
