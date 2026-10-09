import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Q } from '../../common/queue/queues.js';
import { MessagingCoreModule } from '../messaging/messaging.module.js';
import { DashboardController } from './dashboard.controller.js';
import { SimulatorController } from './simulator.controller.js';

@Module({
  imports: [MessagingCoreModule, BullModule.registerQueue({ name: Q.AGENT })],
  controllers: [DashboardController, SimulatorController],
})
export class PanelModule {}
