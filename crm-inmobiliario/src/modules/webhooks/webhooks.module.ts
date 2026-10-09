import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Q } from '../../common/queue/queues.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  imports: [BullModule.registerQueue({ name: Q.WEBHOOKS })],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
