import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { type AuthUser, CurrentUser, Roles } from '../../common/auth/auth.js';
import { defaultJobOptions, type MatchingJob, Q } from '../../common/queue/queues.js';
import { DatabaseService } from '../../database/database.service.js';
import { contacts, leads } from '../../database/schema.js';
import { MatchingService } from '../matching/matching.service.js';
import { PipelineService, stageIdSql } from './pipeline.service.js';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
};

const Requirements = z.object({
  operation: z.enum(['sale', 'rent', 'temporary_rent']).nullish(),
  propertyTypes: z.array(z.string()).optional(),
  neighborhoods: z.array(z.string()).optional(),
  minPrice: z.number().positive().nullish(),
  maxPrice: z.number().positive().nullish(),
  currency: z.enum(['ARS', 'USD']).nullish(),
  minBedrooms: z.number().int().nonnegative().nullish(),
  mustHaves: z.array(z.string()).optional(),
  naturalLanguage: z.string().max(2000).optional(),
});

const CreateLead = z.object({
  fullName: z.string().min(1),
  phoneE164: z.string().regex(/^\+\d{8,15}$/).optional(),
  email: z.string().email().optional(),
  sourceCampaign: z.string().optional(),
  requirements: Requirements.optional(),
});

const MoveStage = z.object({ stageId: z.string().uuid().optional(), stageKey: z.string().optional(), expectedVersion: z.number().int().optional() }).refine(
  (v) => v.stageId || v.stageKey,
  'stageId o stageKey requerido',
);

const Rule = z.object({
  name: z.string(),
  priority: z.number().int().default(100),
  criteria: z
    .object({
      neighborhoods: z.array(z.string()).optional(),
      propertyTypes: z.array(z.string()).optional(),
      operations: z.array(z.string()).optional(),
      channels: z.array(z.string()).optional(),
    })
    .default({}),
  userIds: z.array(z.string().uuid()).min(1),
  active: z.boolean().default(true),
});

@Controller()
export class PipelineController {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly matching: MatchingService,
    private readonly db: DatabaseService,
    @InjectQueue(Q.MATCHING) private readonly matchQueue: Queue<MatchingJob>,
  ) {}

  /** Tablero Kanban. Los asesores comerciales ven solo sus leads. */
  @Get('pipeline')
  board(@CurrentUser() user: AuthUser, @Query('mine') mine?: string) {
    const onlyMine = user.role === 'sales_agent' || mine === 'true';
    return this.pipeline.board(user.tenantId, onlyMine ? { assignedUserId: user.userId } : {});
  }

  @Post('pipeline/stages')
  @Roles('admin')
  createStage(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(
      z.object({ key: z.string().regex(/^[a-z_]+$/), name: z.string(), position: z.number().int(), slaHours: z.number().int().optional(), isWon: z.boolean().optional(), isLost: z.boolean().optional() }),
      body,
    );
    return this.pipeline.createStage(user.tenantId, input);
  }

  @Patch('pipeline/stages/order')
  @Roles('admin')
  reorder(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.pipeline.reorderStages(user.tenantId, parse(z.object({ ids: z.array(z.string().uuid()).min(1) }), body).ids);
  }

  /** Alta manual de lead (llamado, portal, oficina) con requerimientos → asignación + matching. */
  @Post('leads')
  @Roles('admin', 'broker', 'sales_agent')
  async createLead(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(CreateLead, body);
    const lead = await this.db.withTenant(user.tenantId, async (tx) => {
      const [contact] = await tx
        .insert(contacts)
        .values({ tenantId: user.tenantId, fullName: input.fullName, phoneE164: input.phoneE164, email: input.email })
        .returning({ id: contacts.id });
      const [row] = await tx
        .insert(leads)
        .values({ tenantId: user.tenantId, contactId: contact!.id, stageId: stageIdSql(user.tenantId), sourceCampaign: input.sourceCampaign, sourceChannel: 'web' })
        .returning({ id: leads.id });
      return row!;
    });
    if (input.requirements) await this.matching.upsertRequirements(user.tenantId, lead.id, input.requirements);
    const assignedUserId = await this.pipeline.assignLead(user.tenantId, lead.id);
    await this.matchQueue.add('lead', { kind: 'lead', tenantId: user.tenantId, leadId: lead.id }, defaultJobOptions);
    return { leadId: lead.id, assignedUserId };
  }

  /** Mover de etapa (drag & drop del Kanban) con versión esperada → 409 si hubo un cambio concurrente. */
  @Patch('leads/:id/stage')
  moveStage(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(MoveStage, body);
    return this.pipeline.moveLead(user.tenantId, id, input, input.expectedVersion);
  }

  @Post('leads/:id/assign')
  @Roles('admin', 'broker')
  autoAssign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('force') force?: string) {
    return this.pipeline.assignLead(user.tenantId, id, force === 'true').then((assignedUserId) => ({ assignedUserId }));
  }

  @Patch('leads/:id/assignee')
  @Roles('admin', 'broker')
  reassign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.pipeline.reassign(user.tenantId, id, parse(z.object({ userId: z.string().uuid() }), body).userId);
  }

  @Get('assignment-rules')
  @Roles('admin', 'broker')
  rules(@CurrentUser() user: AuthUser) {
    return this.pipeline.listRules(user.tenantId);
  }

  @Post('assignment-rules')
  @Roles('admin')
  createRule(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.pipeline.createRule(user.tenantId, parse(Rule, body));
  }

  // ───────────── Smart matching ─────────────

  @Patch('leads/:id/requirements')
  async requirements(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.matching.upsertRequirements(user.tenantId, id, parse(Requirements, body));
    return this.matching.matchForLead(user.tenantId, id);
  }

  /** Recalcula y devuelve las mejores propiedades para el lead. */
  @Post('leads/:id/matches')
  matchLead(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.matching.matchForLead(user.tenantId, id);
  }

  @Get('leads/:id/matches')
  listMatches(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.matching.listForLead(user.tenantId, id);
  }

  @Patch('matches/:id')
  matchStatus(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.matching.setStatus(user.tenantId, id, parse(z.object({ status: z.enum(['sent', 'dismissed', 'converted']) }), body).status);
  }

  /** Leads interesados en una propiedad (útil al captar un inmueble nuevo). */
  @Post('properties/:id/matching-leads')
  matchProperty(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.matching.matchForProperty(user.tenantId, id);
  }
}
