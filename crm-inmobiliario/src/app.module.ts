import { BullModule } from '@nestjs/bullmq';
import { Controller, Get, Module, Redirect } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditContextInterceptor } from './common/audit/request-context.js';
import { AuthGuard, Public } from './common/auth/auth.js';
import { defaultJobOptions } from './common/queue/queues.js';
import { redisConnectionOptions } from './common/queue/redis.js';
import { DatabaseModule } from './database/database.module.js';
import { AgentsApiModule, AgentsWorkerModule } from './modules/agents/agents.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { BookingModule } from './modules/booking/booking.module.js';
import { DevelopmentsModule } from './modules/developments/developments.module.js';
import { FichasModule } from './modules/fichas/fichas.module.js';
import { MatchingWorkerModule } from './modules/matching/matching.module.js';
import { PanelModule } from './modules/panel/panel.module.js';
import { PipelineModule } from './modules/pipeline/pipeline.module.js';
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

@Controller()
class HealthController {
  @Public()
  @Get('health')
  ok() {
    return { status: 'ok' };
  }

  /** La raíz lleva al panel web. */
  @Public()
  @Get()
  @Redirect('/panel/', 302)
  root() {}
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
    DevelopmentsModule,
    FichasModule,
    PipelineModule,
    BookingModule,
    AuditModule,
    PanelModule,
  ],
  controllers: [HealthController, AuthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    // Abre el contexto de actor (usuario, IP, user-agent, request id) que consumen los triggers de auditoría.
    { provide: APP_INTERCEPTOR, useClass: AuditContextInterceptor },
  ],
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
    MatchingWorkerModule,
  ],
})
export class WorkerModule {}
