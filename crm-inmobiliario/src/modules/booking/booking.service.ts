import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { leads, properties, tenants, users, visits } from '../../database/schema.js';
import { PipelineService } from '../pipeline/pipeline.service.js';
import { AgendaService } from './agenda.service.js';
import { DEFAULT_SLOT_CONFIG, formatSlot, freeSlots, type Interval, type SlotConfig, spreadPick } from './slots.js';

const HORIZON_DAYS = 7;

export interface SlotOption {
  start: string; // ISO UTC
  label: string; // "jueves 16/10 10:30"
}

/**
 * Booker agéntico: calcula disponibilidad real del asesor (agenda propia del
 * CRM: visitas + bloqueos + calendario personal vía iCal) y reserva de forma
 * atómica, sin depender de Google OAuth. La restricción EXCLUDE
 * de `visits` es la última línea de defensa contra la doble reserva cuando
 * dos conversaciones eligen el mismo turno a la vez.
 */
@Injectable()
export class BookingService {

  constructor(
    private readonly db: DatabaseService,
    private readonly agenda: AgendaService,
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

  private busy(tenantId: string, advisor: typeof users.$inferSelect, from: Date, to: Date): Promise<Interval[]> {
    return this.agenda.busy(tenantId, advisor.id, from, to);
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
   * (EXCLUDE impide solapamientos) y (3) avanza el lead a "Visita coordinada".
   * El asesor la ve en su celular a través de su link iCal (se actualiza solo).
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

    return {
      visitId: visit.id,
      when: formatSlot(start, config.utcOffset),
      advisor: advisor.fullName,
      property: `${property.code} – ${property.title}`,
    };
  }

  /** La cancelación aparece en el calendario del asesor como evento cancelado en la próxima actualización del feed. */
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
    return { visitId, status: 'cancelled' };
  }
}
