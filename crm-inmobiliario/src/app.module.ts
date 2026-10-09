import { BullModule } from '@nestjs/bullmq';
import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard, Public } from './common/auth/auth.js';
import { defaultJobOptions } from './common/queue/queues.js';
import { redisConnectionOptions } from './common/queue/redis.js';
import { DatabaseModule } from './database/database.module.js';
import { AgentsApiModule, AgentsWorkerModule } from './modules/agents/agents.module.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { ContractsModule, ContractsWorkerModule } from './modules/contracts/contracts.module.js';
import { FinanceModule, FinanceWorkerModule } from './modules/finance/finance.module.js';
import { MessagingWorkerModule } from './modules/messaging/messaging.module.js';
import { PropertiesModule } from './modules/properties/properties.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';

const queueRoot = BullModule.forRoot({
  connection: redisConnectionOptions(),
  prefix: 'crm',
  defaultJobOptions,
});

@Controller('health')
class HealthController {
  @Public()
  @Get()
  ok() {
    return { status: 'ok' };
  }
}

/** Proceso API (HTTP): controladores + productores de colas. Sin processors. */
@Module({
  imports: [
    queueRoot,
    DatabaseModule,
    WebhooksModule,
    PropertiesModule,
    ContractsModule,
    FinanceModule,
    AgentsApiModule,
  ],
  controllers: [HealthController, AuthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class ApiModule {}

/** Proceso worker: consumidores de colas y schedulers. Escala horizontalmente por separado. */
@Module({
  imports: [
    queueRoot,
    DatabaseModule,
    MessagingWorkerModule,
    AgentsWorkerModule,
    ContractsWorkerModule,
    FinanceWorkerModule,
  ],
})
export class WorkerModule {}
