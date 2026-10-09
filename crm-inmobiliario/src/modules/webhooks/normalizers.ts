/**
 * Normalización de payloads heterogéneos a un único modelo de mensaje
 * entrante. Funciones puras: fáciles de testear con fixtures reales.
 */
export type Channel = 'whatsapp' | 'instagram' | 'messenger' | 'tiktok' | 'youtube' | 'web';

export interface InboundMessage {
  channel: Channel;
  /** ID de la cuenta del negocio (phone_number_id, page_id, ig id, open_id, YT channel id) → resuelve el tenant. */
  accountExternalId: string;
  contactExternalId: string;
  contactName?: string;
  contactPhone?: string;
  externalMessageId: string;
  kind: 'text' | 'audio' | 'image' | 'document' | 'video' | 'location' | 'comment' | 'interactive' | 'unsupported';
  text?: string;
  media?: { id?: string; url?: string; mime?: string };
  /** Contexto extra (p.ej. post/video comentado). */
  context?: Record<string, unknown>;
  timestamp: string;
}

type Obj = Record<string, any>; // payloads externos: se validan campo a campo abajo

const iso = (unixSec: unknown) => new Date(Number(unixSec) * 1000 || Date.now()).toISOString();

export function normalizeWhatsApp(payload: Obj): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const names = new Map<string, string>((value.contacts ?? []).map((c: Obj) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages ?? []) {
        const base = {
          channel: 'whatsapp' as const,
          accountExternalId: String(phoneNumberId),
          contactExternalId: String(m.from),
          contactName: names.get(m.from),
          contactPhone: `+${m.from}`,
          externalMessageId: String(m.id),
          timestamp: iso(m.timestamp),
        };
        switch (m.type) {
          case 'text':
            out.push({ ...base, kind: 'text', text: m.text?.body });
            break;
          case 'audio':
          case 'image':
          case 'document':
          case 'video':
            out.push({
              ...base,
              kind: m.type,
              text: m[m.type]?.caption,
              media: { id: m[m.type]?.id, mime: m[m.type]?.mime_type },
            });
            break;
          case 'interactive':
            out.push({ ...base, kind: 'interactive', text: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title });
            break;
          case 'button':
            out.push({ ...base, kind: 'interactive', text: m.button?.text });
            break;
          case 'location':
            out.push({ ...base, kind: 'location', context: m.location, text: m.location?.address });
            break;
          default:
            out.push({ ...base, kind: 'unsupported' });
        }
      }
      // value.statuses (sent/delivered/read) se ignoran aquí; podrían actualizar el estado de salientes.
    }
  }
  return out;
}

/** Messenger (object=page) e Instagram Direct (object=instagram) + comentarios de IG/FB. */
export function normalizeMeta(payload: Obj): InboundMessage[] {
  const channel: Channel = payload.object === 'instagram' ? 'instagram' : 'messenger';
  const out: InboundMessage[] = [];
  for (const entry of payload.entry ?? []) {
    const accountId = String(entry.id);
    for (const ev of entry.messaging ?? []) {
      const msg = ev.message;
      if (!msg || msg.is_echo) continue; // eco de nuestros propios envíos
      const att = msg.attachments?.[0];
      const kind = att ? (({ audio: 'audio', image: 'image', video: 'video', file: 'document' }) as Obj)[att.type] ?? 'unsupported' : 'text';
      out.push({
        channel,
        accountExternalId: accountId,
        contactExternalId: String(ev.sender?.id),
        externalMessageId: String(msg.mid),
        kind,
        text: msg.text,
        media: att?.payload?.url ? { url: att.payload.url } : undefined,
        timestamp: new Date(Number(ev.timestamp) || Date.now()).toISOString(),
      });
    }
    // Comentarios: Instagram (field=comments) y páginas de Facebook (field=feed, item=comment).
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      if (change.field === 'comments' && v.id) {
        out.push({
          channel,
          accountExternalId: accountId,
          contactExternalId: String(v.from?.id),
          contactName: v.from?.username,
          externalMessageId: `comment:${v.id}`,
          kind: 'comment',
          text: v.text,
          context: { mediaId: v.media?.id, commentId: v.id },
          timestamp: new Date().toISOString(),
        });
      } else if (change.field === 'feed' && v.item === 'comment' && v.verb === 'add') {
        out.push({
          channel: 'messenger',
          accountExternalId: accountId,
          contactExternalId: String(v.from?.id),
          contactName: v.from?.name,
          externalMessageId: `comment:${v.comment_id}`,
          kind: 'comment',
          text: v.message,
          context: { postId: v.post_id, commentId: v.comment_id },
          timestamp: iso(v.created_time),
        });
      }
    }
  }
  return out;
}

/**
 * TikTok: los eventos llegan como { event, user_openid, create_time, content }
 * donde `content` es un JSON serializado. Se normalizan comentarios y
 * mensajes directos; el resto se descarta.
 */
export function normalizeTikTok(payload: Obj): InboundMessage[] {
  let content: Obj = {};
  try {
    content = typeof payload.content === 'string' ? JSON.parse(payload.content) : payload.content ?? {};
  } catch {
    return [];
  }
  const event = String(payload.event ?? '');
  if (!/comment|message/i.test(event)) return [];
  const id = content.comment_id ?? content.message_id ?? content.id;
  if (!id) return [];
  return [
    {
      channel: 'tiktok',
      accountExternalId: String(payload.user_openid),
      contactExternalId: String(content.user_openid ?? content.from_user_id ?? content.sender_id ?? 'unknown'),
      contactName: content.username ?? content.display_name,
      externalMessageId: `${event}:${id}`,
      kind: /comment/i.test(event) ? 'comment' : 'text',
      text: content.text ?? content.comment ?? content.message,
      context: { videoId: content.video_id, event },
      timestamp: iso(payload.create_time),
    },
  ];
}
