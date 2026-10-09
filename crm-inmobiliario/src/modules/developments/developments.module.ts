import { Module } from '@nestjs/common';
import { AgentsCoreModule } from '../agents/agents-core.module.js';
import { DevelopmentsController } from './developments.controller.js';
import { DevelopmentsService } from './developments.service.js';

@Module({ imports: [AgentsCoreModule], controllers: [DevelopmentsController], providers: [DevelopmentsService] })
export class DevelopmentsModule {}
