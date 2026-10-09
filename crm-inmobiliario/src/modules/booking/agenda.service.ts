import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gte, lt } from 'drizzle-orm';
import { isPublicHttpsUrl } from '../../common/net/fetchable.js';
import { env } from '../../config/env.js';
import { DatabaseService } from '../../database/database.service.js';
import { availabilityBlocks, contacts, leads, properties, users, visits } from '../../database/schema.js';
import { TenantSecretsService } from '../tenants/tenant-secrets.service.js';
import { buildIcs, type IcsEvent, parseBusy } from './ical.js';
import type { Interval } from './slots.js';

const externalSecret = (userId: string) => `external_ical:${userId}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const MAX_ICS_BYTES = 2 * 1024 * 1024;
const EXTERNAL_CACHE_MS = 5 * 60_000;

/**
 * Agenda propia del CRM (sin Google OAuth, costo $0):
 *  - bloqueos manuales de disponibilidad del asesor;
 *  - link iCal privado por asesor para ver sus visitas en el celular;
 *  - lectura opcional del iCal secreto de su calendario personal (ocupado/libre).
 */
@Injectable()
export class AgendaService {
  private readonly log = new Logger(AgendaService.name);
  private readonly externalCache = new Map<string, { at: number; text: string }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly secrets: TenantSecretsService,
  ) {}

  // ───────────── Ocupación del asesor ─────────────

  /** Ocupado = visitas agendadas + bloqueos + calendario personal (si lo configuró). */
  async busy(tenantId: string, userId: string, from: Date, to: Date): Promise<Interval[]> {
    const [internal, blocks] = await this.db.withTenant(tenantId, (tx) =>
      Promise.all([
        tx
          .select({ start: visits.startsAt, end: visits.endsAt })
          .from(visits)
          .where(and(eq(visits.userId, userId), eq(visits.status, 'scheduled'), lt(visits.startsAt, to), gte(visits.endsAt, from))),
        tx
          .select({ start: availabilityBlocks.startsAt, end: availabilityBlocks.endsAt })
          .from(availabilityBlocks)
          .where(and(eq(availabilityBlocks.userId, userId), lt(availabilityBlocks.startsAt, to), gte(availabilityBlocks.endsAt, from))),
      ]),
    );
    return [...internal, ...blocks, ...(await this.externalBusy(tenantId, userId, from, to))];
  }

  /**
   * Si el calendario externo no responde, se sigue con la agenda interna (se
   * registra el error): un problema de Google/Apple no debe frenar las reservas.
   */
  private async externalBusy(tenantId: string, userId: string, from: Date, to: Date): Promise<Interval[]> {
    const url = await this.secrets.get(tenantId, externalSecret(userId));
    if (!url) return [];
    try {
      return parseBusy(await this.fetchIcs(url), from, to);
    } catch (err) {
      this.log.warn(`Calendario externo de ${userId} no disponible: ${String(err)}`);
      return [];
    }
  }

  private async fetchIcs(url: string, useCache = true): Promise<string> {
    const key = sha256(url);
    const hit = this.externalCache.get(key);
    if (useCache && hit && Date.now() - hit.at < EXTERNAL_CACHE_MS) return hit.text;
    if (!isPublicHttpsUrl(url)) throw new Error('URL de calendario no permitida');
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error', headers: { Accept: 'text/calendar' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ICS_BYTES) throw new Error('Calendario demasiado grande');
    const text = buf.toString('utf8');
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('La URL no devuelve un calendario iCal');
    this.externalCache.set(key, { at: Date.now(), text });
    return text;
  }

  /** Guarda (cifrada) la dirección secreta iCal del calendario personal, validándola antes. */
  async setExternalCalendar(tenantId: string, userId: string, url: string) {
    if (!isPublicHttpsUrl(url)) throw new BadRequestException('Debe ser una URL https pública (p. ej. la "dirección secreta en formato iCal" de Google Calendar)');
    let events: number;
    try {
      const now = new Date();
      events = parseBusy(await this.fetchIcs(url, false), now, new Date(now.getTime() + 14 * 86_400_000)).length;
    } catch (err) {
      throw new BadRequestException(`No se pudo leer el calendario: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.secrets.set(tenantId, externalSecret(userId), url);
    return { connected: true, busySlotsNext14Days: events };
  }

  async removeExternalCalendar(tenantId: string, userId: string) {
    await this.secrets.set(tenantId, externalSecret(userId), '');
    return { connected: false };
  }

  // ───────────── Bloqueos ─────────────

  listBlocks(tenantId: string, userId: string) {
    return this.db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(availabilityBlocks)
        .where(and(eq(availabilityBlocks.userId, userId), gte(availabilityBlocks.endsAt, new Date())))
        .orderBy(availabilityBlocks.startsAt),
    );
  }

  addBlock(tenantId: string, userId: string, startsAt: Date, endsAt: Date, reason?: string) {
    if (!(endsAt > startsAt)) throw new BadRequestException('El fin debe ser posterior al inicio');
    return this.db.withTenant(tenantId, (tx) => tx.insert(availabilityBlocks).values({ tenantId, userId, startsAt, endsAt, reason }).returning());
  }

  async removeBlock(tenantId: string, userId: string, blockId: string, isManager: boolean) {
    const [row] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .delete(availabilityBlocks)
        .where(and(eq(availabilityBlocks.id, blockId), isManager ? undefined : eq(availabilityBlocks.userId, userId)))
        .returning({ id: availabilityBlocks.id }),
    );
    if (!row) throw new NotFoundException();
    return { deleted: row.id };
  }

  // ───────────── Link iCal del asesor ─────────────

  /**
   * Genera un link nuevo (el anterior deja de funcionar). Solo se guarda el
   * hash del token: si la base se filtra, los links no.
   */
  async rotateFeedLink(tenantId: string, userId: string): Promise<{ url: string; webcal: string }> {
    const token = randomBytes(24).toString('base64url');
    await this.db.withTenant(tenantId, (tx) => tx.update(users).set({ icalFeedTokenHash: sha256(token) }).where(eq(users.id, userId)));
    const url = `${env().PUBLIC_BASE_URL}/public/calendars/${token}.ics`;
    return { url, webcal: url.replace(/^https?:/, 'webcal:') };
  }

  async revokeFeedLink(tenantId: string, userId: string) {
    await this.db.withTenant(tenantId, (tx) => tx.update(users).set({ icalFeedTokenHash: null }).where(eq(users.id, userId)));
    return { revoked: true };
  }

  /** Feed público por token: visitas del asesor de los últimos 30 días y los próximos 90. */
  async feed(token: string): Promise<string | undefined> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
    // Única consulta cross-tenant: resolver el dueño del token (rol system).
    const [owner] = await this.db.system
      .select({ id: users.id, tenantId: users.tenantId, name: users.fullName })
      .from(users)
      .where(and(eq(users.icalFeedTokenHash, sha256(token)), eq(users.active, true)));
    if (!owner) return undefined;

    const from = new Date(Date.now() - 30 * 86_400_000);
    const to = new Date(Date.now() + 90 * 86_400_000);
    const rows = await this.db.withTenant(owner.tenantId, (tx) =>
      tx
        .select({ v: visits, p: { code: properties.code, title: properties.title, address: properties.address, neighborhood: properties.neighborhood }, c: { name: contacts.fullName, phone: contacts.phoneE164 } })
        .from(visits)
        .innerJoin(properties, eq(properties.id, visits.propertyId))
        .innerJoin(leads, eq(leads.id, visits.leadId))
        .innerJoin(contacts, eq(contacts.id, leads.contactId))
        .where(and(eq(visits.userId, owner.id), gte(visits.startsAt, from), lt(visits.startsAt, to))),
    );
    return buildIcs(`Visitas – ${owner.name}`, rows.map(toIcsEvent));
  }

  /** .ics de una sola visita ("Agregar a mi calendario"). */
  async visitIcs(tenantId: string, visitId: string): Promise<string> {
    const [row] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select({ v: visits, p: { code: properties.code, title: properties.title, address: properties.address, neighborhood: properties.neighborhood }, c: { name: contacts.fullName, phone: contacts.phoneE164 } })
        .from(visits)
        .innerJoin(properties, eq(properties.id, visits.propertyId))
        .innerJoin(leads, eq(leads.id, visits.leadId))
        .innerJoin(contacts, eq(contacts.id, leads.contactId))
        .where(eq(visits.id, visitId)),
    );
    if (!row) throw new NotFoundException();
    return buildIcs('Visita', [toIcsEvent(row)]);
  }
}

function toIcsEvent(r: {
  v: typeof visits.$inferSelect;
  p: { code: string; title: string; address: string | null; neighborhood: string | null };
  c: { name: string | null; phone: string | null };
}): IcsEvent {
  return {
    uid: `visit-${r.v.id}@crm-inmobiliario`,
    start: r.v.startsAt,
    end: r.v.endsAt,
    summary: `Visita ${r.p.code} – ${r.c.name ?? 'interesado'}`,
    description: [r.p.title, r.c.name && `Contacto: ${r.c.name}`, r.c.phone && `Tel: ${r.c.phone}`, `Agendada por: ${r.v.bookedBy}`, r.v.notes]
      .filter(Boolean)
      .join('\n'),
    location: r.p.address ?? r.p.neighborhood ?? undefined,
    status: r.v.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
    sequence: r.v.version,
    updatedAt: r.v.updatedAt,
  };
}
