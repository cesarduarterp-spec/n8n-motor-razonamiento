import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Q } from '../../common/queue/queues.js';
import { MatchingModule } from '../matching/matching.module.js';
import { PipelineController } from './pipeline.controller.js';
import { PipelineService } from './pipeline.service.js';

@Module({ providers: [PipelineService], exports: [PipelineService] })
export class PipelineCoreModule {}

@Module({
  imports: [PipelineCoreModule, MatchingModule, BullModule.registerQueue({ name: Q.MATCHING })],
  controllers: [PipelineController],
})
export class PipelineModule {}
