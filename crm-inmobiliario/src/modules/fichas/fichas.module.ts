import { Module } from '@nestjs/common';
import { FichasController } from './fichas.controller.js';
import { FichasService } from './fichas.service.js';

@Module({ controllers: [FichasController], providers: [FichasService] })
export class FichasModule {}
