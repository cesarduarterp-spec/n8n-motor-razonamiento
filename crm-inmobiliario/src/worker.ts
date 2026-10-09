import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './app.module.js';
import { env } from './config/env.js';

async function bootstrap() {
  env();
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks(); // cierra workers BullMQ ordenadamente (termina jobs activos)
  Logger.log('Workers iniciados', 'Bootstrap');
}

void bootstrap();
