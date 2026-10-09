import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Q } from '../../common/queue/queues.js';
import { BillingService } from './billing.service.js';
import { FinanceController } from './finance.controller.js';
import { BillingProcessor, FinanceSchedules, IndexProcessor } from './finance.processors.js';

@Module({
  imports: [BullModule.registerQueue({ name: Q.INDEXES }, { name: Q.BILLING })],
  controllers: [FinanceController],
  providers: [BillingService],
  exports: [BillingService],
})
export class FinanceModule {}

/** Solo en el proceso worker: processors + schedulers. */
@Module({
  imports: [FinanceModule, BullModule.registerQueue({ name: Q.INDEXES }, { name: Q.BILLING })],
  providers: [IndexProcessor, BillingProcessor, FinanceSchedules],
})
export class FinanceWorkerModule {}
