import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { Job } from 'bullmq';
import { RequestContext } from '../../common/audit/request-context.js';
import { type MatchingJob, Q } from '../../common/queue/queues.js';
import { AgentsCoreModule } from '../agents/agents-core.module.js';
import { MatchingService } from './matching.service.js';

@Module({
  imports: [AgentsCoreModule],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}

/** Recalcula matches en segundo plano (lead nuevo/actualizado o propiedad nueva). */
@Processor(Q.MATCHING, { concurrency: 4 })
export class MatchingProcessor extends WorkerHost {
  constructor(private readonly matching: MatchingService) {
    super();
  }

  process(job: Job<MatchingJob>) {
    return RequestContext.run({ actorType: 'agent', agentId: 'matcher' }, async () => {
      const d = job.data;
      const matches =
        d.kind === 'lead' ? await this.matching.matchForLead(d.tenantId, d.leadId) : await this.matching.matchForProperty(d.tenantId, d.propertyId);
      return { matches: matches.length };
    });
  }
}

@Module({ imports: [MatchingModule], providers: [MatchingProcessor] })
export class MatchingWorkerModule {}
