import { InjectQueue } from '@nestjs/bullmq';
import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { Public } from '../../common/auth/auth.js';
import { defaultJobOptions, Q, type WebhookJob } from '../../common/queue/queues.js';
import { env } from '../../config/env.js';
import { verifyMetaSignature, verifyTikTokSignature } from './signatures.js';

/**
 * Gateway de webhooks. Regla de oro: validar firma, encolar y responder 200
 * en milisegundos. Todo el procesamiento (resolución de tenant, descarga de
 * media, IA) ocurre en workers. El jobId es el hash del cuerpo: si la
 * plataforma reintenta el mismo evento, BullMQ lo descarta como duplicado.
 */
@Public()
@Controller('webhooks')
export class WebhooksController {
  private readonly log = new Logger(WebhooksController.name);

  constructor(@InjectQueue(Q.WEBHOOKS) private readonly queue: Queue<WebhookJob>) {}

  /** Verificación de suscripción (WhatsApp Cloud API, Messenger, Instagram). */
  @Get('meta')
  verifyMeta(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    if (mode === 'subscribe' && token === env().META_VERIFY_TOKEN) return challenge;
    throw new ForbiddenException();
  }

  @Post('meta')
  @HttpCode(200)
  async receiveMeta(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature?: string) {
    const raw = this.raw(req);
    if (!verifyMetaSignature(raw, signature, env().META_APP_SECRET)) throw new UnauthorizedException('Firma inválida');
    const body = req.body as { object?: string };
    const provider = body.object === 'whatsapp_business_account' ? 'whatsapp' : 'meta';
    await this.enqueue({ provider, payload: body, receivedAt: new Date().toISOString() }, raw);
    return 'EVENT_RECEIVED';
  }

  @Post('tiktok')
  @HttpCode(200)
  async receiveTikTok(@Req() req: RawBodyRequest<Request>, @Headers('tiktok-signature') signature?: string) {
    const secret = env().TIKTOK_CLIENT_SECRET;
    const raw = this.raw(req);
    if (!secret || !verifyTikTokSignature(raw, signature, secret)) throw new UnauthorizedException('Firma inválida');
    await this.enqueue({ provider: 'tiktok', payload: req.body, receivedAt: new Date().toISOString() }, raw);
    return { ok: true };
  }

  /**
   * YouTube no envía webhooks de comentarios: solo notifica videos nuevos vía
   * WebSub (PubSubHubbub). Lo usamos para disparar el poll de comentarios
   * del canal; además hay un poll periódico (ver YouTubePoller).
   */
  @Get('youtube')
  verifyYouTube(@Query('hub.challenge') challenge: string, @Query('hub.topic') topic: string): string {
    if (!topic?.startsWith('https://www.youtube.com/xml/feeds/videos.xml?channel_id=')) throw new ForbiddenException();
    return challenge;
  }

  @Post('youtube')
  @HttpCode(204)
  async receiveYouTube(@Req() req: RawBodyRequest<Request>) {
    const raw = this.raw(req);
    const xml = raw.toString('utf8');
    const channelId = /<yt:channelId>([^<]+)<\/yt:channelId>/.exec(xml)?.[1];
    const videoId = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(xml)?.[1];
    if (channelId) await this.enqueue({ provider: 'youtube', payload: { channelId, videoId }, receivedAt: new Date().toISOString() }, raw);
  }

  private raw(req: RawBodyRequest<Request>): Buffer {
    if (!req.rawBody) throw new UnauthorizedException('Cuerpo vacío');
    return req.rawBody;
  }

  private async enqueue(job: WebhookJob, raw: Buffer) {
    const jobId = `${job.provider}-${createHash('sha256').update(raw).digest('hex')}`;
    await this.queue.add(job.provider, job, { ...defaultJobOptions, jobId });
    this.log.debug(`webhook ${job.provider} encolado ${jobId}`);
  }
}
