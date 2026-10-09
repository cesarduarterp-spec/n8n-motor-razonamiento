import { Module } from '@nestjs/common';
import { TenantSecretsService } from './tenant-secrets.service.js';

@Module({ providers: [TenantSecretsService], exports: [TenantSecretsService] })
export class TenantsModule {}
