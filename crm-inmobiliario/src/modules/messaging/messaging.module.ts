import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Q } from '../../common/queue/queues.js';
import { StorageService } from '../../common/storage.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { ChannelGateway } from './channel-gateway.service.js';
import { InboxService } from './inbox.service.js';
import { OutboundProcessor, WebhookProcessor, YouTubePollScheduler } from './messaging.processors.js';

/** Ingesta y salida de mensajes (lo usan los workers y el simulador del panel). */
@Module({
  imports: [TenantsModule],
  providers: [ChannelGateway, InboxService, StorageService],
  exports: [ChannelGateway, InboxService],
})
export class MessagingCoreModule {}

@Module({
  imports: [MessagingCoreModule, BullModule.registerQueue({ name: Q.WEBHOOKS }, { name: Q.AGENT }, { name: Q.OUTBOUND })],
  providers: [WebhookProcessor, OutboundProcessor, YouTubePollScheduler],
})
export class MessagingWorkerModule {}
