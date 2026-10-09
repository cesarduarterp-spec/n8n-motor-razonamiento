import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type AuthUser, CurrentUser } from '../../common/auth/auth.js';
import { type AgentJob, defaultJobOptions, Q } from '../../common/queue/queues.js';
import { DatabaseService } from '../../database/database.service.js';
import { aiDecisionLogs, channelAccounts, conversations, messages } from '../../database/schema.js';
import { InboxService } from '../messaging/inbox.service.js';

const Send = z.object({
  sessionId: z.string().uuid(),
  contactName: z.string().min(1).max(80).default('Cliente de prueba'),
  text: z.string().min(1).max(2000),
});

/** Debounce corto para el simulador (en WhatsApp es 4 s). */
const SIM_DEBOUNCE_MS = 1_500;

/**
 * Simulador de chat del panel: prueba el agente completo (Gemini, router,
 * Claude, herramientas, pipeline, agenda) sin WhatsApp ni Meta. Usa el canal
 * `web` y el mismo pipeline de ingesta que los webhooks reales, así que lo
 * que se ve acá es lo que pasaría en producción.
 */
@Controller('simulator')
export class SimulatorController {
  constructor(
    private readonly db: DatabaseService,
    private readonly inbox: InboxService,
    @InjectQueue(Q.AGENT) private readonly agent: Queue<AgentJob>,
  ) {}

  @Post('messages')
  async send(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const parsed = Send.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { sessionId, contactName, text } = parsed.data;
    const accountExternalId = `web-${user.tenantId}`;

    await this.db.withTenant(user.tenantId, (tx) =>
      tx
        .insert(channelAccounts)
        .values({ tenantId: user.tenantId, channel: 'web', externalAccountId: accountExternalId, displayName: 'Simulador del panel' })
        .onConflictDoNothing(),
    );

    const res = await this.inbox.ingest({
      channel: 'web',
      accountExternalId,
      contactExternalId: `sim-${sessionId}`,
      contactName,
      externalMessageId: `sim-${randomUUID()}`,
      kind: 'text',
      text,
      timestamp: new Date().toISOString(),
    });
    if (!res) throw new BadRequestException('No se pudo registrar el mensaje');

    if (!res.humanTakeover) {
      await this.agent.add(
        'turn',
        { tenantId: res.tenantId, conversationId: res.conversationId, contactId: res.contactId, messageId: res.messageId },
        { ...defaultJobOptions, attempts: 2, delay: SIM_DEBOUNCE_MS, deduplication: { id: `conv-${res.conversationId}`, ttl: SIM_DEBOUNCE_MS, extend: true, replace: true } },
      );
    }
    return { conversationId: res.conversationId, messageId: res.messageId, humanTakeover: res.humanTakeover };
  }

  /** Mensajes + "qué pensó el bot" (intención, motor, motivo, herramientas) + último error del worker. */
  @Get('conversations/:id')
  async conversation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const data = await this.db.withTenant(user.tenantId, async (tx) => {
      const [conv] = await tx.select().from(conversations).where(eq(conversations.id, id));
      if (!conv) throw new NotFoundException();
      const msgs = await tx
        .select({ id: messages.id, direction: messages.direction, author: messages.author, body: messages.body, intent: messages.intent, createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(asc(messages.createdAt));
      const decisions = await tx
        .select({
          id: aiDecisionLogs.id,
          engine: aiDecisionLogs.engine,
          model: aiDecisionLogs.model,
          task: aiDecisionLogs.task,
          messageId: aiDecisionLogs.messageId,
          routingReason: aiDecisionLogs.routingReason,
          toolsInvoked: aiDecisionLogs.toolsInvoked,
          rawResponse: aiDecisionLogs.rawResponse,
          inputTokens: aiDecisionLogs.inputTokens,
          outputTokens: aiDecisionLogs.outputTokens,
          latencyMs: aiDecisionLogs.latencyMs,
          outcome: aiDecisionLogs.outcome,
          createdAt: aiDecisionLogs.createdAt,
        })
        .from(aiDecisionLogs)
        .where(eq(aiDecisionLogs.conversationId, id))
        .orderBy(asc(aiDecisionLogs.createdAt));
      return { humanTakeover: conv.humanTakeover, msgs, decisions };
    });

    // Último error del agente para esta conversación (p. ej. falta GEMINI_API_KEY o el worker no corre).
    const failed = await this.agent.getJobs(['failed'], 0, 30, false);
    const lastFailed = failed
      .filter((j) => j?.data?.conversationId === id)
      .sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0))[0];

    return {
      humanTakeover: data.humanTakeover,
      messages: data.msgs,
      decisions: data.decisions.map((d) => ({
        ...d,
        // Solo lo necesario para la vista: la respuesta cruda completa queda en auditoría.
        rawResponse: d.task === 'route' ? d.rawResponse : undefined,
        toolsInvoked: d.toolsInvoked?.map((t) => ({ name: t.name, args: t.args, error: t.error })),
      })),
      lastError: lastFailed?.failedReason ? String(lastFailed.failedReason).slice(0, 300) : null,
      lastErrorAt: lastFailed?.finishedOn ? new Date(lastFailed.finishedOn).toISOString() : null,
    };
  }

  /** Devuelve la conversación al bot después de una derivación a humano. */
  @Post('conversations/:id/release')
  async release(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.withTenant(user.tenantId, (tx) => tx.update(conversations).set({ humanTakeover: false }).where(eq(conversations.id, id)));
    return { humanTakeover: false };
  }
}
