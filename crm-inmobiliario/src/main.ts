import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiModule } from './app.module.js';
import { env } from './config/env.js';

async function bootstrap() {
  const config = env(); // fail-fast si falta configuración
  // rawBody: necesario para verificar firmas HMAC de webhooks sobre los bytes exactos recibidos.
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { rawBody: true });
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('text', { type: ['application/atom+xml', 'application/xml'] }); // WebSub de YouTube
  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
  Logger.log(`API escuchando en :${config.PORT}`, 'Bootstrap');
}

void bootstrap();
