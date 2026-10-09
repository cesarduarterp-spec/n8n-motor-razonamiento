import { Injectable } from '@nestjs/common';
import { env } from '../../config/env.js';
import { TenantSecretsService } from '../tenants/tenant-secrets.service.js';

export interface ChannelTarget {
  tenantId: string;
  channel: 'whatsapp' | 'instagram' | 'messenger' | 'tiktok' | 'youtube' | 'web' | 'email';
  accountExternalId: string; // phone_number_id / page_id / ig id
  accessTokenSecret: string | null;
  recipientExternalId: string; // wa_id / PSID / IGSID
}

/** Cliente de salida a las APIs de las plataformas (envío de mensajes y descarga de media). */
@Injectable()
export class ChannelGateway {
  constructor(private readonly secrets: TenantSecretsService) {}

  private graph(path: string) {
    return `https://graph.facebook.com/${env().META_GRAPH_VERSION}/${path}`;
  }

  private async token(tenantId: string, secretName: string | null, fallback: string): Promise<string> {
    const token = await this.secrets.get(tenantId, secretName ?? fallback);
    if (!token) throw new Error(`Falta el secreto ${secretName ?? fallback} del tenant`);
    return token;
  }

  async sendText(target: ChannelTarget, text: string): Promise<string | undefined> {
    switch (target.channel) {
      case 'whatsapp': {
        const token = await this.token(target.tenantId, target.accessTokenSecret, 'whatsapp_access_token');
        const res = await this.post(this.graph(`${target.accountExternalId}/messages`), token, {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: target.recipientExternalId,
          type: 'text',
          text: { preview_url: true, body: text.slice(0, 4096) },
        });
        return res.messages?.[0]?.id;
      }
      case 'messenger':
      case 'instagram': {
        const token = await this.token(target.tenantId, target.accessTokenSecret, 'meta_page_token');
        const res = await this.post(this.graph(`${target.accountExternalId}/messages`), token, {
          recipient: { id: target.recipientExternalId },
          messaging_type: 'RESPONSE',
          message: { text: text.slice(0, 2000) },
        });
        return res.message_id;
      }
      default:
        // TikTok / YouTube: responder comentarios requiere OAuth del creador y scopes específicos;
        // se deriva a un humano en lugar de enviar.
        throw new Error(`Envío automático no soportado en ${target.channel}`);
    }
  }

  /** Plantilla aprobada de WhatsApp: obligatoria fuera de la ventana de 24 h. */
  async sendWhatsAppTemplate(target: ChannelTarget, template: string, lang: string, params: string[]) {
    const token = await this.token(target.tenantId, target.accessTokenSecret, 'whatsapp_access_token');
    return this.post(this.graph(`${target.accountExternalId}/messages`), token, {
      messaging_product: 'whatsapp',
      to: target.recipientExternalId,
      type: 'template',
      template: {
        name: template,
        language: { code: lang },
        components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
      },
    });
  }

  /** WhatsApp: media_id → URL temporal → binario (ambos pasos con el token del negocio). */
  async downloadWhatsAppMedia(tenantId: string, secretName: string | null, mediaId: string): Promise<{ data: Buffer; mime: string }> {
    const token = await this.token(tenantId, secretName, 'whatsapp_access_token');
    const meta = (await this.get(this.graph(mediaId), token).then((r) => r.json())) as { url: string; mime_type: string };
    const bin = await this.get(meta.url, token);
    return { data: Buffer.from(await bin.arrayBuffer()), mime: meta.mime_type };
  }

  /** Messenger/IG entregan URLs firmadas de CDN: se descargan sin token. */
  async downloadUrl(url: string): Promise<{ data: Buffer; mime: string }> {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Descarga de media falló: HTTP ${res.status}`);
    return { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'application/octet-stream' };
  }

  private async get(url: string, token: string) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    return res;
  }

  private async post(url: string, token: string, body: unknown): Promise<any> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
    return json;
  }
}
