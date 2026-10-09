import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiModule } from './app.module.js';
import { env } from './config/env.js';

async function bootstrap() {
  const config = env(); // fail-fast si falta configuración
  // rawBody: necesario para verificar firmas HMAC de webhooks sobre los bytes exactos recibidos.
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { rawBody: true });
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('text', { type: ['application/atom+xml', 'application/xml'] }); // WebSub de YouTube
  // Detrás de un reverse proxy / ingress: req.ip = IP real del cliente (para el audit trail).
  app.set('trust proxy', process.env.TRUST_PROXY_HOPS ? Number(process.env.TRUST_PROXY_HOPS) : 1);
  // Panel web (archivos estáticos, sin build): http://localhost:3000/panel
  app.useStaticAssets(join(process.cwd(), 'panel'), { prefix: '/panel', index: 'index.html', maxAge: '5m' });
  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
  Logger.log(`API escuchando en :${config.PORT}`, 'Bootstrap');
}

void bootstrap();
