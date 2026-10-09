import { Module } from '@nestjs/common';
import { PipelineCoreModule } from '../pipeline/pipeline.module.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { AgendaService } from './agenda.service.js';
import { BookingController } from './booking.controller.js';
import { BookingService } from './booking.service.js';

@Module({
  imports: [TenantsModule, PipelineCoreModule],
  providers: [BookingService, AgendaService],
  exports: [BookingService, AgendaService],
})
export class BookingCoreModule {}

@Module({ imports: [BookingCoreModule], controllers: [BookingController] })
export class BookingModule {}
