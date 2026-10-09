import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Q } from '../../common/queue/queues.js';
import { StorageService } from '../../common/storage.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { ChannelGateway } from './channel-gateway.service.js';
import { InboxService } from './inbox.service.js';
import { OutboundProcessor, WebhookProcessor, YouTubePollScheduler } from './messaging.processors.js';

@Module({
  imports: [TenantsModule, BullModule.registerQueue({ name: Q.WEBHOOKS }, { name: Q.AGENT }, { name: Q.OUTBOUND })],
  providers: [ChannelGateway, InboxService, StorageService, WebhookProcessor, OutboundProcessor, YouTubePollScheduler],
  exports: [ChannelGateway],
})
export class MessagingWorkerModule {}
