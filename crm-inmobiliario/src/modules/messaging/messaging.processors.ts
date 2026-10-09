import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { type AgentJob, defaultJobOptions, type OutboundJob, Q, type WebhookJob } from '../../common/queue/queues.js';
import { env } from '../../config/env.js';
import { DatabaseService } from '../../database/database.service.js';
import { channelAccounts, contactIdentities, conversations, messages } from '../../database/schema.js';
import { type InboundMessage, normalizeMeta, normalizeTikTok, normalizeWhatsApp } from '../webhooks/normalizers.js';
import { ChannelGateway } from './channel-gateway.service.js';
import { InboxService } from './inbox.service.js';

/** Ventana de debounce: agrupa ráfagas ("hola" / "quería consultar" / "por el depto") en un solo turno del agente. */
const AGENT_DEBOUNCE_MS = 4_000;

@Processor(Q.WEBHOOKS, { concurrency: 20 })
export class WebhookProcessor extends WorkerHost {
  private readonly log = new Logger(WebhookProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    @InjectQueue(Q.AGENT) private readonly agent: Queue<AgentJob>,
  ) {
    super();
  }

  async process(job: Job<WebhookJob>) {
    const payload = job.data.payload as Record<string, unknown>;
    let inbound: InboundMessage[];
    switch (job.data.provider) {
      case 'whatsapp':
        inbound = normalizeWhatsApp(payload);
        break;
      case 'meta':
        inbound = normalizeMeta(payload);
        break;
      case 'tiktok':
        inbound = normalizeTikTok(payload);
        break;
      case 'youtube':
        inbound = await this.pollYouTube(String(payload.channelId));
        break;
    }

    let routed = 0;
    for (const msg of inbound) {
      const res = await this.inbox.ingest(msg);
      if (!res || res.humanTakeover || msg.kind === 'unsupported') continue;
      await this.agent.add(
        'turn',
        { tenantId: res.tenantId, conversationId: res.conversationId, contactId: res.contactId, messageId: res.messageId },
        {
          ...defaultJobOptions,
          attempts: 3,
          delay: AGENT_DEBOUNCE_MS,
          // Debounce: cada mensaje nuevo de la misma conversación reemplaza el job pendiente y extiende la espera.
          deduplication: { id: `conv-${res.conversationId}`, ttl: AGENT_DEBOUNCE_MS, extend: true, replace: true },
        },
      );
      routed++;
    }
    return { normalized: inbound.length, routed };
  }

  /** Comentarios recientes del canal vía YouTube Data API v3 (los duplicados se descartan por external_id). */
  private async pollYouTube(channelId: string): Promise<InboundMessage[]> {
    const key = env().YOUTUBE_API_KEY;
    if (!key) return [];
    const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
    url.search = new URLSearchParams({
      part: 'snippet',
      allThreadsRelatedToChannelId: channelId,
      order: 'time',
      maxResults: '50',
      key,
    }).toString();
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`YouTube API HTTP ${res.status}`);
    const body = (await res.json()) as { items?: Array<Record<string, any>> };
    return (body.items ?? []).map((item) => {
      const s = item.snippet?.topLevelComment?.snippet ?? {};
      return {
        channel: 'youtube' as const,
        accountExternalId: channelId,
        contactExternalId: String(s.authorChannelId?.value ?? s.authorDisplayName),
        contactName: s.authorDisplayName,
        externalMessageId: `comment:${item.id}`,
        kind: 'comment' as const,
        text: s.textOriginal,
        context: { videoId: s.videoId, commentId: item.id },
        timestamp: s.publishedAt ?? new Date().toISOString(),
      };
    });
  }
}

/** Poll periódico de YouTube (complementa WebSub, que solo avisa de videos nuevos). */
@Injectable()
export class YouTubePollScheduler implements OnApplicationBootstrap {
  constructor(
    private readonly db: DatabaseService,
    @InjectQueue(Q.WEBHOOKS) private readonly webhooks: Queue<WebhookJob>,
  ) {}

  async onApplicationBootstrap() {
    const accounts = await this.db.system
      .select({ id: channelAccounts.externalAccountId })
      .from(channelAccounts)
      .where(and(eq(channelAccounts.channel, 'youtube'), eq(channelAccounts.active, true)));
    for (const a of accounts) {
      await this.webhooks.upsertJobScheduler(`yt-poll-${a.id}`, { every: 10 * 60_000 }, {
        name: 'youtube',
        data: { provider: 'youtube', payload: { channelId: a.id }, receivedAt: new Date().toISOString() },
      });
    }
  }
}

@Processor(Q.OUTBOUND, { concurrency: 10 })
export class OutboundProcessor extends WorkerHost {
  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: ChannelGateway,
  ) {
    super();
  }

  async process(job: Job<OutboundJob>) {
    const { tenantId, conversationId, text, author } = job.data;
    const target = await this.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select({ conv: conversations, account: channelAccounts, identity: contactIdentities })
        .from(conversations)
        .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
        .innerJoin(
          contactIdentities,
          and(eq(contactIdentities.contactId, conversations.contactId), eq(contactIdentities.channel, conversations.channel)),
        )
        .where(eq(conversations.id, conversationId))
        .limit(1);
      return row;
    });
    if (!target) throw new Error(`Conversación ${conversationId} sin cuenta/identidad de canal`);

    // WhatsApp: fuera de la ventana de 24 h solo se permiten plantillas aprobadas.
    const last = target.conv.lastInboundAt?.getTime() ?? 0;
    if (target.conv.channel === 'whatsapp' && Date.now() - last > 24 * 3600_000) {
      throw new Error('Fuera de la ventana de 24 h de WhatsApp: usar plantilla (sendWhatsAppTemplate)');
    }

    const externalId = await this.gateway.sendText(
      {
        tenantId,
        channel: target.conv.channel,
        accountExternalId: target.account.externalAccountId,
        accessTokenSecret: target.account.accessTokenSecret,
        recipientExternalId: target.identity.externalId,
      },
      text,
    );

    await this.db.withTenant(tenantId, (tx) =>
      tx.insert(messages).values({ tenantId, conversationId, direction: 'outbound', author, externalId, kind: 'text', body: text }),
    );
    return { externalId };
  }
}
