import { InjectQueue } from '@nestjs/bullmq';
import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { type AuthUser, CurrentUser, Roles } from '../../common/auth/auth.js';
import { defaultJobOptions, type OutboundJob, Q } from '../../common/queue/queues.js';
import { DatabaseService } from '../../database/database.service.js';
import { agentDrafts, contractParties } from '../../database/schema.js';
import { todayIn } from '../finance/dates.js';
import { ClaudeSpecialist } from './claude-specialist.service.js';
import { MemoryService } from './memory.service.js';

/**
 * Human-in-the-loop: todo lo que Claude redacta con riesgo (avisos de mora,
 * intimaciones, respuestas a reclamos) espera aprobación de un
 * martillero/admin antes de salir.
 */
@Controller('agent-drafts')
export class DraftsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly claude: ClaudeSpecialist,
    private readonly memory: MemoryService,
    @InjectQueue(Q.OUTBOUND) private readonly outbound: Queue<OutboundJob>,
  ) {}

  @Get()
  @Roles('admin', 'broker', 'back_office')
  pending(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, (tx) =>
      tx.select().from(agentDrafts).where(eq(agentDrafts.status, 'pending_approval')).orderBy(agentDrafts.createdAt),
    );
  }

  /** Aprueba (opcionalmente editando el texto) y envía por el canal de la conversación. */
  @Post(':id/approve')
  @Roles('admin', 'broker')
  async approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: { content?: string }) {
    const draft = await this.db.withTenant(user.tenantId, async (tx) => {
      const [row] = await tx
        .update(agentDrafts)
        .set({ status: 'approved', approvedBy: user.userId, ...(body?.content ? { content: body.content } : {}) })
        .where(and(eq(agentDrafts.id, id), eq(agentDrafts.status, 'pending_approval')))
        .returning();
      return row;
    });
    if (!draft) throw new NotFoundException();
    if (draft.conversationId) {
      await this.outbound.add(
        'send',
        { tenantId: user.tenantId, conversationId: draft.conversationId, text: draft.content, author: 'human' },
        defaultJobOptions,
      );
      await this.db.withTenant(user.tenantId, (tx) => tx.update(agentDrafts).set({ status: 'sent' }).where(eq(agentDrafts.id, id)));
    }
    return { id, status: draft.conversationId ? 'sent' : 'approved' };
  }

  @Post(':id/reject')
  @Roles('admin', 'broker')
  async reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const [row] = await this.db.withTenant(user.tenantId, (tx) =>
      tx
        .update(agentDrafts)
        .set({ status: 'rejected', approvedBy: user.userId })
        .where(and(eq(agentDrafts.id, id), eq(agentDrafts.status, 'pending_approval')))
        .returning({ id: agentDrafts.id }),
    );
    if (!row) throw new NotFoundException();
    return { id, status: 'rejected' };
  }

  /** Pide a Claude un aviso formal de mora para un contrato. Queda como borrador. */
  @Post('late-notice/:contractId')
  @Roles('admin', 'broker', 'back_office')
  async lateNotice(@CurrentUser() user: AuthUser, @Param('contractId', ParseUUIDPipe) contractId: string) {
    const context = await this.db.withTenant(user.tenantId, async (tx) => {
      const [party] = await tx.select().from(contractParties).where(eq(contractParties.contractId, contractId)).limit(1);
      if (!party) throw new NotFoundException('Contrato inexistente');
      return this.memory.contractContext(tx, [contractId]);
    });
    const d = await this.claude.draftLateNotice(user.tenantId, context, todayIn());
    const [row] = await this.db.withTenant(user.tenantId, (tx) =>
      tx
        .insert(agentDrafts)
        .values({
          tenantId: user.tenantId,
          contractId,
          kind: 'late_payment_notice',
          content: d.draft?.content ?? d.replyToContact,
          rationale: d.internalNote,
          riskLevel: d.riskLevel,
        })
        .returning(),
    );
    return row;
  }
}
