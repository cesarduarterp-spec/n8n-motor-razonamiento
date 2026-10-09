import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DatabaseService, type TenantTx } from '../../database/database.service.js';
import {
  assignmentRules,
  assignmentState,
  contacts,
  leadRequirements,
  leads,
  pipelineStages,
  users,
} from '../../database/schema.js';
import { type Candidate, pickAssignee, ruleMatches } from './assignment.js';

/** Subconsulta del id de una etapa por clave (o la primera del tenant). */
export function stageIdSql(tenantId: string, key?: string) {
  return key
    ? sql<string>`(select id from pipeline_stages where tenant_id = ${tenantId} and key = ${key})`
    : sql<string>`(select id from pipeline_stages where tenant_id = ${tenantId} order by position limit 1)`;
}

/** Lead abierto más reciente de un contacto (no cerrado ni eliminado). */
export async function activeLeadFor(tx: TenantTx, contactId: string) {
  const [row] = await tx
    .select({ lead: leads })
    .from(leads)
    .innerJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
    .where(and(eq(leads.contactId, contactId), eq(pipelineStages.isWon, false), eq(pipelineStages.isLost, false)))
    .orderBy(desc(leads.createdAt))
    .limit(1);
  return row?.lead;
}

@Injectable()
export class PipelineService {
  constructor(private readonly db: DatabaseService) {}

  // ───────────── Kanban ─────────────

  board(tenantId: string, filter: { assignedUserId?: string } = {}) {
    return this.db.withTenant(tenantId, async (tx) => {
      const stages = await tx.select().from(pipelineStages).where(eq(pipelineStages.tenantId, tenantId)).orderBy(asc(pipelineStages.position));
      const cards = await tx
        .select({
          id: leads.id,
          stageId: leads.stageId,
          version: leads.version,
          contactName: contacts.fullName,
          phone: contacts.phoneE164,
          assignedUserId: leads.assignedUserId,
          assignedTo: users.fullName,
          sourceChannel: leads.sourceChannel,
          score: leads.score,
          stageChangedAt: leads.stageChangedAt,
          requirements: leadRequirements.naturalLanguage,
        })
        .from(leads)
        .innerJoin(contacts, eq(contacts.id, leads.contactId))
        .leftJoin(users, eq(users.id, leads.assignedUserId))
        .leftJoin(leadRequirements, eq(leadRequirements.leadId, leads.id))
        .where(filter.assignedUserId ? eq(leads.assignedUserId, filter.assignedUserId) : undefined)
        .orderBy(desc(leads.stageChangedAt))
        .limit(2000);

      const now = Date.now();
      return stages.map((s) => ({
        ...s,
        leads: cards
          .filter((c) => c.stageId === s.id)
          .map((c) => ({
            ...c,
            // SLA vencido: el lead lleva en la etapa más horas que las configuradas.
            slaBreached: Boolean(s.slaHours && c.stageChangedAt && now - c.stageChangedAt.getTime() > s.slaHours * 3600_000),
          })),
      }));
    });
  }

  /**
   * Mueve un lead de etapa con control de concurrencia optimista: si otro
   * usuario lo movió antes (version distinta) responde 409 en lugar de pisar
   * el cambio. El audit trail registra old/new automáticamente.
   */
  async moveLead(tenantId: string, leadId: string, stage: { stageId?: string; stageKey?: string }, expectedVersion?: number) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [target] = await tx
        .select()
        .from(pipelineStages)
        .where(stage.stageId ? eq(pipelineStages.id, stage.stageId) : eq(pipelineStages.key, stage.stageKey ?? ''));
      if (!target) throw new NotFoundException('Etapa inexistente');

      const [updated] = await tx
        .update(leads)
        .set({ stageId: target.id })
        .where(and(eq(leads.id, leadId), expectedVersion !== undefined ? eq(leads.version, expectedVersion) : undefined))
        .returning({ id: leads.id, stageId: leads.stageId, version: leads.version });
      if (updated) return updated;

      const [exists] = await tx.select({ version: leads.version }).from(leads).where(eq(leads.id, leadId));
      if (!exists) throw new NotFoundException('Lead inexistente');
      throw new ConflictException({ message: 'El lead fue modificado por otro usuario', currentVersion: exists.version });
    });
  }

  /**
   * Avance automático (agentes): solo hacia adelante y nunca saca a un lead
   * de una etapa de cierre. Evita que el bot "retroceda" un lead en negociación.
   */
  async advanceTo(tx: TenantTx, leadId: string, key: string): Promise<boolean> {
    const res = await tx.execute(sql`
      update leads l set stage_id = target.id
        from pipeline_stages target, pipeline_stages cur
       where l.id = ${leadId}
         and cur.id = l.stage_id
         and target.tenant_id = l.tenant_id and target.key = ${key}
         and target.position > cur.position
         and not cur.is_won and not cur.is_lost`);
    return (res.rowCount ?? 0) > 0;
  }

  createStage(tenantId: string, input: { key: string; name: string; position: number; slaHours?: number; isWon?: boolean; isLost?: boolean }) {
    return this.db.withTenant(tenantId, (tx) => tx.insert(pipelineStages).values({ tenantId, ...input }).returning());
  }

  /** Reordena el tablero: recibe los ids en el orden deseado. */
  reorderStages(tenantId: string, orderedIds: string[]) {
    return this.db.withTenant(tenantId, async (tx) => {
      for (const [i, id] of orderedIds.entries()) {
        await tx.update(pipelineStages).set({ position: i + 1 }).where(eq(pipelineStages.id, id));
      }
      return tx.select().from(pipelineStages).orderBy(asc(pipelineStages.position));
    });
  }

  // ───────────── Asignación automática ─────────────

  /**
   * Asigna un lead sin asesor. Evalúa reglas por prioridad (zona, tipo,
   * operación, canal); si ninguna aplica usa el pool general de asesores
   * comerciales y brokers. Un advisory lock por tenant serializa las
   * asignaciones concurrentes para que el reparto sea realmente equitativo.
   */
  async assign(tx: TenantTx, tenantId: string, leadId: string, opts: { force?: boolean } = {}): Promise<string | undefined> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`assign:${tenantId}`}))`);

    const [lead] = await tx
      .select({ lead: leads, req: leadRequirements })
      .from(leads)
      .leftJoin(leadRequirements, eq(leadRequirements.leadId, leads.id))
      .where(eq(leads.id, leadId));
    if (!lead) throw new NotFoundException('Lead inexistente');
    if (lead.lead.assignedUserId && !opts.force) return lead.lead.assignedUserId;

    const facts = {
      neighborhoods: lead.req?.neighborhoods ?? [],
      propertyTypes: lead.req?.propertyTypes ?? [],
      operation: lead.req?.operation,
      channel: lead.lead.sourceChannel,
    };
    const rules = await tx
      .select()
      .from(assignmentRules)
      .where(and(eq(assignmentRules.active, true)))
      .orderBy(asc(assignmentRules.priority));
    const rule = rules.find((r) => ruleMatches(r.criteria, facts));

    const poolIds = rule
      ? rule.userIds
      : (
          await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.active, true), inArray(users.role, ['sales_agent', 'broker'])))
        ).map((u) => u.id);
    if (poolIds.length === 0) return undefined;

    const stats = await tx.execute<{ user_id: string; open_leads: number; last_assigned_at: Date | null }>(sql`
      select u.id as user_id,
             count(l.id) filter (where not s.is_won and not s.is_lost)::int as open_leads,
             max(l.assigned_at) as last_assigned_at
        from users u
        left join leads l on l.assigned_user_id = u.id and l.deleted_at is null
        left join pipeline_stages s on s.id = l.stage_id
       where u.id in (${sql.join(poolIds.map((id) => sql`${id}::uuid`), sql`, `)}) and u.active
       group by u.id`);
    const candidates: Candidate[] = stats.rows.map((r) => ({
      userId: r.user_id,
      openLeads: Number(r.open_leads),
      lastAssignedAt: r.last_assigned_at ? new Date(r.last_assigned_at) : null,
    }));
    const chosen = pickAssignee(candidates);
    if (!chosen) return undefined;

    await tx.update(leads).set({ assignedUserId: chosen, assignedAt: new Date() }).where(eq(leads.id, leadId));
    if (rule) {
      await tx
        .insert(assignmentState)
        .values({ tenantId, ruleId: rule.id, userId: chosen, assignedCount: 1, lastAssignedAt: new Date() })
        .onConflictDoUpdate({
          target: [assignmentState.ruleId, assignmentState.userId],
          set: { assignedCount: sql`${assignmentState.assignedCount} + 1`, lastAssignedAt: new Date() },
        });
    }
    return chosen;
  }

  assignLead(tenantId: string, leadId: string, force = false) {
    return this.db.withTenant(tenantId, (tx) => this.assign(tx, tenantId, leadId, { force }));
  }

  /** Asignación manual (override humano), también auditada. */
  reassign(tenantId: string, leadId: string, userId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [u] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.active, true)));
      if (!u) throw new NotFoundException('Usuario inexistente o inactivo');
      const [row] = await tx
        .update(leads)
        .set({ assignedUserId: userId, assignedAt: new Date() })
        .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)))
        .returning({ id: leads.id, assignedUserId: leads.assignedUserId, version: leads.version });
      if (!row) throw new NotFoundException('Lead inexistente');
      return row;
    });
  }

  createRule(tenantId: string, input: Omit<typeof assignmentRules.$inferInsert, 'tenantId' | 'id'>) {
    return this.db.withTenant(tenantId, (tx) => tx.insert(assignmentRules).values({ ...input, tenantId }).returning());
  }

  listRules(tenantId: string) {
    return this.db.withTenant(tenantId, (tx) => tx.select().from(assignmentRules).orderBy(asc(assignmentRules.priority)));
  }
}
