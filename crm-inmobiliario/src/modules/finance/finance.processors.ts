import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { type BillingJob, type IndexJob, Q } from '../../common/queue/queues.js';
import { addMonths, firstOfMonth, todayIn } from './dates.js';
import { BillingService } from './billing.service.js';

const TZ = 'America/Argentina/Buenos_Aires';

/**
 * Registra los cron como Job Schedulers de BullMQ (persistidos en Redis).
 * A diferencia de un @Cron en memoria, con N réplicas del worker cada
 * disparo se ejecuta UNA sola vez.
 */
@Injectable()
export class FinanceSchedules implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(Q.INDEXES) private readonly indexes: Queue<IndexJob>,
    @InjectQueue(Q.BILLING) private readonly billing: Queue<BillingJob>,
  ) {}

  async onApplicationBootstrap() {
    // ICL: el BCRA publica el valor diario; se consulta 2 veces por día.
    await this.indexes.upsertJobScheduler('icl-daily', { pattern: '0 15 9,19 * * *', tz: TZ }, { name: 'icl', data: { kind: 'icl' } });
    // IPC: INDEC publica ~día 12-15 de cada mes; se consulta a diario del 10 al 20.
    await this.indexes.upsertJobScheduler('ipc-monthly', { pattern: '0 0 18 10-20 * *', tz: TZ }, { name: 'ipc', data: { kind: 'ipc' } });
    // Mora/punitorios y recálculo: todos los días 06:00.
    await this.billing.upsertJobScheduler('billing-daily', { pattern: '0 0 6 * * *', tz: TZ }, { name: 'fanout', data: { kind: 'fanout-daily' } });
  }
}

@Processor(Q.INDEXES, { concurrency: 1 })
export class IndexProcessor extends WorkerHost {
  private readonly log = new Logger(IndexProcessor.name);

  constructor(
    private readonly billingService: BillingService,
    @InjectQueue(Q.BILLING) private readonly billing: Queue<BillingJob>,
  ) {
    super();
  }

  async process(job: Job<IndexJob>) {
    const n = job.data.kind === 'icl' ? await this.billingService.ingestIcl() : await this.billingService.ingestIpc();
    // Índices nuevos → recalcular cuotas provisionales de todos los tenants.
    if (n > 0) {
      for (const tenantId of await this.billingService.activeTenantIds()) {
        await this.billing.add('apply-adjustments', { kind: 'apply-adjustments', tenantId }, {
          deduplication: { id: `adj-${tenantId}`, ttl: 60_000 },
        });
      }
    }
    this.log.log(`${job.data.kind}: ${n} puntos`);
    return { points: n };
  }
}

@Processor(Q.BILLING, { concurrency: 4 })
export class BillingProcessor extends WorkerHost {
  constructor(
    private readonly billingService: BillingService,
    @InjectQueue(Q.BILLING) private readonly billing: Queue<BillingJob>,
  ) {
    super();
  }

  async process(job: Job<BillingJob>) {
    const data = job.data;
    switch (data.kind) {
      case 'fanout-daily': {
        // Un job por tenant: aísla fallas y paraleliza.
        const today = todayIn();
        const prevMonth = firstOfMonth(addMonths(today, -1));
        const jobs = (await this.billingService.activeTenantIds()).flatMap((tenantId) => [
          { name: 'apply', data: { kind: 'apply-adjustments' as const, tenantId } },
          { name: 'overdue', data: { kind: 'mark-overdue' as const, tenantId } },
          // Liquidación del mes anterior el día 5 (idempotente por unique index).
          ...(today.endsWith('-05') ? [{ name: 'settle', data: { kind: 'settle-month' as const, tenantId, periodMonth: prevMonth } }] : []),
        ]);
        await this.billing.addBulk(jobs);
        return { tenants: jobs.length };
      }
      case 'apply-adjustments':
        return { contracts: await this.billingService.applyAdjustments(data.tenantId) };
      case 'mark-overdue':
        return { overdue: await this.billingService.markOverdue(data.tenantId) };
      case 'settle-month':
        return { settled: await this.billingService.settleMonth(data.tenantId, data.periodMonth) };
    }
  }
}
