import { Controller, Get, Query } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.js';
import { DatabaseService } from '../../database/database.service.js';
import {
  agentDrafts,
  aiDecisionLogs,
  auditLogs,
  contacts,
  leads,
  paymentSchedules,
  pipelineStages,
  properties,
  tenants,
  users,
  visits,
} from '../../database/schema.js';

/** Endpoints de lectura que alimentan el panel web. */
@Controller()
export class DashboardController {
  constructor(private readonly db: DatabaseService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, async (tx) => {
      const [u] = await tx.select({ id: users.id, fullName: users.fullName, email: users.email, role: users.role }).from(users).where(eq(users.id, user.userId));
      const [t] = await tx.select({ name: tenants.name, slug: tenants.slug }).from(tenants).where(eq(tenants.id, user.tenantId));
      return { user: u, tenant: t };
    });
  }

  @Get('dashboard/summary')
  summary(@CurrentUser() user: AuthUser) {
    const mine = user.role === 'sales_agent';
    const now = new Date();
    const in7 = new Date(now.getTime() + 7 * 86_400_000);
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    return this.db.withTenant(user.tenantId, async (tx) => {
      const byStage = await tx
        .select({ key: pipelineStages.key, name: pipelineStages.name, isWon: pipelineStages.isWon, isLost: pipelineStages.isLost, count: sql<number>`count(${leads.id})::int` })
        .from(pipelineStages)
        .leftJoin(leads, and(eq(leads.stageId, pipelineStages.id), mine ? eq(leads.assignedUserId, user.userId) : undefined))
        .groupBy(pipelineStages.id)
        .orderBy(asc(pipelineStages.position));

      const upcoming = await tx
        .select({
          id: visits.id,
          startsAt: visits.startsAt,
          property: properties.title,
          code: properties.code,
          contact: contacts.fullName,
          advisor: users.fullName,
        })
        .from(visits)
        .innerJoin(properties, eq(properties.id, visits.propertyId))
        .innerJoin(leads, eq(leads.id, visits.leadId))
        .innerJoin(contacts, eq(contacts.id, leads.contactId))
        .innerJoin(users, eq(users.id, visits.userId))
        .where(and(eq(visits.status, 'scheduled'), gte(visits.startsAt, now), lt(visits.startsAt, in7), mine ? eq(visits.userId, user.userId) : undefined))
        .orderBy(asc(visits.startsAt))
        .limit(6);

      const [drafts] = await tx.select({ n: sql<number>`count(*)::int` }).from(agentDrafts).where(eq(agentDrafts.status, 'pending_approval'));
      const [overdue] = await tx
        .select({ n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${paymentSchedules.amount} + ${paymentSchedules.penaltyAmount} - ${paymentSchedules.paidAmount}), 0)` })
        .from(paymentSchedules)
        .where(eq(paymentSchedules.status, 'overdue'));
      const ai = await tx
        .select({ engine: aiDecisionLogs.engine, n: sql<number>`count(*)::int`, tokens: sql<number>`coalesce(sum(${aiDecisionLogs.inputTokens} + ${aiDecisionLogs.outputTokens}), 0)::int` })
        .from(aiDecisionLogs)
        .where(gte(aiDecisionLogs.createdAt, startOfDay))
        .groupBy(aiDecisionLogs.engine);
      const [props] = await tx.select({ n: sql<number>`count(*)::int` }).from(properties).where(eq(properties.status, 'available'));

      const activity =
        user.role === 'admin'
          ? await tx
              .select({ action: auditLogs.action, entity: auditLogs.entityName, actorType: auditLogs.actorType, agentId: auditLogs.agentId, userId: auditLogs.userId, at: auditLogs.occurredAt })
              .from(auditLogs)
              .orderBy(desc(auditLogs.seq))
              .limit(8)
          : [];

      return {
        kpis: {
          openLeads: byStage.filter((s) => !s.isWon && !s.isLost).reduce((a, s) => a + s.count, 0),
          wonLeads: byStage.filter((s) => s.isWon).reduce((a, s) => a + s.count, 0),
          visitsNext7: upcoming.length,
          pendingApprovals: drafts?.n ?? 0,
          overdueInstallments: overdue?.n ?? 0,
          overdueAmount: Number(overdue?.total ?? 0),
          availableProperties: props?.n ?? 0,
          aiCallsToday: ai.filter((a) => a.engine !== 'router').reduce((s, a) => s + a.n, 0),
        },
        aiByEngine: ai,
        leadsByStage: byStage.map(({ key, name, count, isWon, isLost }) => ({ key, name, count, isWon, isLost })),
        upcomingVisits: upcoming,
        activity,
      };
    });
  }

  /** Visitas para la agenda del panel (asesor: las propias; admin/broker: todas o filtradas). */
  @Get('visits')
  visitsList(@CurrentUser() user: AuthUser, @Query('days') days = '14', @Query('userId') userId?: string) {
    const from = new Date(Date.now() - 86_400_000);
    const to = new Date(Date.now() + Math.min(Number(days) || 14, 90) * 86_400_000);
    const only = user.role === 'sales_agent' ? user.userId : userId;
    return this.db.withTenant(user.tenantId, (tx) =>
      tx
        .select({
          id: visits.id,
          startsAt: visits.startsAt,
          endsAt: visits.endsAt,
          status: visits.status,
          bookedBy: visits.bookedBy,
          property: properties.title,
          code: properties.code,
          contact: contacts.fullName,
          phone: contacts.phoneE164,
          advisor: users.fullName,
          advisorId: users.id,
        })
        .from(visits)
        .innerJoin(properties, eq(properties.id, visits.propertyId))
        .innerJoin(leads, eq(leads.id, visits.leadId))
        .innerJoin(contacts, eq(contacts.id, leads.contactId))
        .innerJoin(users, eq(users.id, visits.userId))
        .where(and(gte(visits.startsAt, from), lt(visits.startsAt, to), inArray(visits.status, ['scheduled', 'done']), only ? eq(visits.userId, only) : undefined))
        .orderBy(asc(visits.startsAt)),
    );
  }

  /** Equipo (para filtros y reglas de asignación). */
  @Get('users')
  team(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, (tx) =>
      tx.select({ id: users.id, fullName: users.fullName, role: users.role, active: users.active }).from(users).orderBy(asc(users.fullName)),
    );
  }
}
