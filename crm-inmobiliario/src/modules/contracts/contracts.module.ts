import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type ContractExtractionJob, Q } from '../../common/queue/queues.js';
import { StorageService } from '../../common/storage.js';
import { AgentsCoreModule } from '../agents/agents-core.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { ContractExtractionService } from './contract-extraction.service.js';
import { ContractsController } from './contracts.controller.js';

@Processor(Q.CONTRACTS, { concurrency: 2 })
export class ContractExtractionProcessor extends WorkerHost {
  constructor(private readonly extraction: ContractExtractionService) {
    super();
  }

  process(job: Job<ContractExtractionJob>) {
    return this.extraction.process(job.data.tenantId, job.data.documentId);
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: Q.CONTRACTS })],
  controllers: [ContractsController],
  providers: [StorageService],
})
export class ContractsModule {}

@Module({
  imports: [FinanceModule, AgentsCoreModule],
  providers: [StorageService, ContractExtractionService, ContractExtractionProcessor],
})
export class ContractsWorkerModule {}
