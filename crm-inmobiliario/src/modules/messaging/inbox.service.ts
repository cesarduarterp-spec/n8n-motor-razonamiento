import { Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { StorageService } from '../../common/storage.js';
import { DatabaseService } from '../../database/database.service.js';
import {
  channelAccounts,
  contactIdentities,
  contacts,
  conversationMemory,
  conversations,
  leads,
  messages,
} from '../../database/schema.js';
import type { InboundMessage } from '../webhooks/normalizers.js';
import { stageIdSql } from '../pipeline/pipeline.service.js';
import { ChannelGateway } from './channel-gateway.service.js';

export interface IngestResult {
  tenantId: string;
  conversationId: string;
  contactId: string;
  messageId: string;
  humanTakeover: boolean;
}

/**
 * Ingesta omnicanal: resuelve el tenant por la cuenta receptora, unifica el
 * contacto (identidad por canal), persiste el mensaje de forma idempotente y
 * descarga la media al storage del tenant.
 */
@Injectable()
export class InboxService {
  private readonly log = new Logger(InboxService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: ChannelGateway,
    private readonly storage: StorageService,
  ) {}

  /** Única consulta cross-tenant: rol SYSTEM sobre channel_accounts. */
  async resolveAccount(channel: InboundMessage['channel'], accountExternalId: string) {
    const [acc] = await this.db.system
      .select()
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.channel, channel),
          eq(channelAccounts.externalAccountId, accountExternalId),
          eq(channelAccounts.active, true),
        ),
      );
    return acc;
  }

  /** Devuelve undefined si el mensaje es duplicado o la cuenta no está registrada. */
  async ingest(msg: InboundMessage): Promise<IngestResult | undefined> {
    const account = await this.resolveAccount(msg.channel, msg.accountExternalId);
    if (!account) {
      this.log.warn(`Cuenta ${msg.channel}:${msg.accountExternalId} no registrada; mensaje descartado`);
      return undefined;
    }
    const tenantId = account.tenantId;

    // Media fuera de la transacción (I/O de red lento).
    let media: { path: string; mime: string } | undefined;
    if (msg.media?.id || msg.media?.url) {
      try {
        const file = msg.media.id
          ? await this.gateway.downloadWhatsAppMedia(tenantId, account.accessTokenSecret, msg.media.id)
          : await this.gateway.downloadUrl(msg.media.url!);
        const ext = file.mime.split('/')[1]?.split(';')[0] ?? 'bin';
        media = { path: (await this.storage.put(tenantId, `media/${msg.channel}`, file.data, ext)).path, mime: file.mime };
      } catch (err) {
        this.log.error(`No se pudo descargar media de ${msg.externalMessageId}: ${String(err)}`);
      }
    }

    return this.db.withTenant(tenantId, async (tx) => {
      // 1) Identidad → contacto (si es nuevo, se crea como prospecto con un lead).
      const [identity] = await tx
        .select({ contactId: contactIdentities.contactId })
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.tenantId, tenantId),
            eq(contactIdentities.channel, msg.channel),
            eq(contactIdentities.externalId, msg.contactExternalId),
          ),
        );

      let contactId = identity?.contactId;
      if (!contactId) {
        // Unificación omnicanal por teléfono: el mismo número que ya escribió por otro canal.
        const [byPhone] = msg.contactPhone
          ? await tx
              .select({ id: contacts.id })
              .from(contacts)
              .where(and(eq(contacts.tenantId, tenantId), eq(contacts.phoneE164, msg.contactPhone)))
          : [];
        contactId =
          byPhone?.id ??
          (
            await tx
              .insert(contacts)
              .values({ tenantId, fullName: msg.contactName, phoneE164: msg.contactPhone })
              .returning({ id: contacts.id })
          )[0]!.id;
        await tx
          .insert(contactIdentities)
          .values({ tenantId, contactId, channel: msg.channel, externalId: msg.contactExternalId, handle: msg.contactName })
          .onConflictDoNothing();
        if (!byPhone) {
          await tx.insert(leads).values({ tenantId, contactId, sourceChannel: msg.channel, stageId: stageIdSql(tenantId) });
          await tx.insert(conversationMemory).values({ tenantId, contactId }).onConflictDoNothing();
        }
      }

      // 2) Conversación por (contacto, canal).
      const [conversation] = await tx
        .insert(conversations)
        .values({ tenantId, contactId, channel: msg.channel, channelAccountId: account.id, lastInboundAt: new Date(msg.timestamp) })
        .onConflictDoUpdate({
          target: [conversations.tenantId, conversations.contactId, conversations.channel],
          set: { lastInboundAt: sql`excluded.last_inbound_at`, channelAccountId: account.id },
        })
        .returning();

      // 3) Mensaje idempotente por external_id.
      const [inserted] = await tx
        .insert(messages)
        .values({
          tenantId,
          conversationId: conversation!.id,
          direction: 'inbound',
          author: 'contact',
          externalId: msg.externalMessageId,
          kind: msg.kind,
          body: msg.text,
          mediaPath: media?.path,
          mediaMime: media?.mime ?? msg.media?.mime,
          enrichment: msg.context ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: messages.id });
      if (!inserted) return undefined; // duplicado

      return {
        tenantId,
        conversationId: conversation!.id,
        contactId,
        messageId: inserted.id,
        humanTakeover: conversation!.humanTakeover,
      };
    });
  }
}
