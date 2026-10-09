import { Module } from '@nestjs/common';
import { PipelineCoreModule } from '../pipeline/pipeline.module.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { BookingController } from './booking.controller.js';
import { BookingService } from './booking.service.js';
import { GoogleCalendarClient } from './google-calendar.client.js';

@Module({
  imports: [TenantsModule, PipelineCoreModule],
  providers: [BookingService, GoogleCalendarClient],
  exports: [BookingService],
})
export class BookingCoreModule {}

@Module({ imports: [BookingCoreModule, TenantsModule], controllers: [BookingController], providers: [GoogleCalendarClient] })
export class BookingModule {}
