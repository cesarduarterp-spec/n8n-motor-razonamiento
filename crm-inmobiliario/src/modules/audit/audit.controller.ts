import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { type AuthUser, CurrentUser, Roles } from '../../common/auth/auth.js';
import { DatabaseService } from '../../database/database.service.js';
import { aiDecisionLogs, auditLogs } from '../../database/schema.js';

const ENTITIES = new Set([
  'properties', 'developments', 'property_units', 'price_lists', 'listing_private_data', 'contacts', 'leads',
  'lead_requirements', 'visits', 'messages', 'contracts', 'payment_schedules', 'payment_receipts', 'users',
  'pipeline_stages', 'assignment_rules', 'agent_drafts', 'settlements', 'ai_decision_logs',
]);

/** Fechas como RFC3339 en UTC (con milisegundos) para exportación/peritajes. */
const rfc3339 = (d: Date) => d.toISOString();

@Controller('audit')
@Roles('admin')
export class AuditController {
  constructor(private readonly db: DatabaseService) {}

  /** Historial completo (versiones) de una entidad: quién cambió qué, cuándo, desde dónde. */
  @Get('entities/:entity/:id')
  async history(@CurrentUser() user: AuthUser, @Param('entity') entity: string, @Param('id') id: string) {
    if (!ENTITIES.has(entity)) throw new BadRequestException('Entidad no auditable');
    const rows = await this.db.withTenant(user.tenantId, (tx) =>
      tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityName, entity), eq(auditLogs.entityId, id)))
        .orderBy(auditLogs.seq),
    );
    return rows.map((r) => ({ ...r, occurredAt: rfc3339(r.occurredAt) }));
  }

  /** Búsqueda en el trail: por acción, usuario, agente o rango de fechas. */
  @Get('logs')
  async search(
    @CurrentUser() user: AuthUser,
    @Query('action') action?: string,
    @Query('userId') userId?: string,
    @Query('agentId') agentId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit = '100',
  ) {
    const rows = await this.db.withTenant(user.tenantId, (tx) =>
      tx
        .select()
        .from(auditLogs)
        .where(
          and(
            action ? sql`${auditLogs.action}::text = ${action}` : undefined,
            userId ? eq(auditLogs.userId, userId) : undefined,
            agentId ? eq(auditLogs.agentId, agentId) : undefined,
            from ? gte(auditLogs.occurredAt, new Date(from)) : undefined,
            to ? lte(auditLogs.occurredAt, new Date(to)) : undefined,
          ),
        )
        .orderBy(desc(auditLogs.seq))
        .limit(Math.min(Number(limit) || 100, 1000)),
    );
    return rows.map((r) => ({ ...r, occurredAt: rfc3339(r.occurredAt) }));
  }

  /** Verifica la cadena de hashes del tenant: detecta cualquier alteración o borrado. */
  @Post('verify')
  async verify(@CurrentUser() user: AuthUser) {
    const res = await this.db.withTenant(user.tenantId, (tx) =>
      tx.execute<{ entries: number; first_broken_seq: number | null }>(sql`select * from audit_verify_chain(${user.tenantId}::uuid)`),
    );
    const row = res.rows[0];
    return { entries: row?.entries ?? 0, intact: row?.first_broken_seq == null, firstBrokenSeq: row?.first_broken_seq ?? null };
  }

  /** Decisiones de IA de una conversación: prompt, tools, respuesta cruda, tokens y motivo de ruteo. */
  @Get('ai/conversations/:id')
  ai(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, (tx) =>
      tx.select().from(aiDecisionLogs).where(eq(aiDecisionLogs.conversationId, id)).orderBy(aiDecisionLogs.createdAt),
    );
  }

  /** Papelera: entidades con soft delete. */
  @Get('trash/:entity')
  async trash(@CurrentUser() user: AuthUser, @Param('entity') entity: string) {
    if (!TRASHABLE.has(entity)) throw new BadRequestException();
    const res = await this.db.withTenant(
      user.tenantId,
      (tx) => tx.execute(sql`select id, deleted_at, deleted_by, version from ${sql.identifier(entity)} where deleted_at is not null order by deleted_at desc limit 200`),
      { includeDeleted: true },
    );
    return res.rows;
  }

  /** Restaura una entidad borrada (queda como RESTORE en el audit trail, con versión incrementada). */
  @Post('trash/:entity/:id/restore')
  async restore(@CurrentUser() user: AuthUser, @Param('entity') entity: string, @Param('id', ParseUUIDPipe) id: string) {
    if (!TRASHABLE.has(entity)) throw new BadRequestException();
    const res = await this.db.withTenant(
      user.tenantId,
      (tx) =>
        tx.execute(
          sql`update ${sql.identifier(entity)} set deleted_at = null, deleted_by = null where id = ${id} and deleted_at is not null returning id, version`,
        ),
      { includeDeleted: true },
    );
    if (!res.rows[0]) throw new BadRequestException('No está en la papelera');
    return res.rows[0];
  }
}

const TRASHABLE = new Set(['properties', 'developments', 'property_units', 'contacts', 'leads', 'contracts', 'visits', 'messages', 'payment_receipts']);
