import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Q } from '../../common/queue/queues.js';
import { RedisLock } from '../../common/queue/redis.js';
import { StorageService } from '../../common/storage.js';
import { PropertiesModule } from '../properties/properties.module.js';
import { AgentsCoreModule } from './agents-core.module.js';
import { DraftsController } from './drafts.controller.js';
import { MemoryService } from './memory.service.js';
import { AgentOrchestrator, AgentProcessor } from './orchestrator.js';

/** API: bandeja de borradores de Claude pendientes de aprobación. */
@Module({
  imports: [AgentsCoreModule, BullModule.registerQueue({ name: Q.OUTBOUND })],
  controllers: [DraftsController],
  providers: [MemoryService],
})
export class AgentsApiModule {}

/** Worker: orquestador híbrido. */
@Module({
  imports: [AgentsCoreModule, PropertiesModule, BullModule.registerQueue({ name: Q.OUTBOUND })],
  providers: [MemoryService, StorageService, RedisLock, AgentOrchestrator, AgentProcessor],
})
export class AgentsWorkerModule {}
