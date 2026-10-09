import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { openSecret, sealSecret } from '../../common/crypto/secret-box.js';
import { DatabaseService } from '../../database/database.service.js';
import { tenantSecrets, tenants } from '../../database/schema.js';

export type SecretName =
  | 'anthropic_api_key'
  | 'gemini_api_key'
  | 'whatsapp_access_token'
  | 'meta_page_token'
  | 'tiktok_access_token'
  | 'youtube_oauth_refresh_token'
  | (string & {});

/** Secretos por tenant, cifrados en reposo; caché corta en memoria para no descifrar en cada mensaje. */
@Injectable()
export class TenantSecretsService {
  private readonly cache = new Map<string, { value: string | undefined; exp: number }>();

  constructor(private readonly db: DatabaseService) {}

  async get(tenantId: string, name: SecretName): Promise<string | undefined> {
    const key = `${tenantId}:${name}`;
    const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.value;

    const value = await this.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select({ c: tenantSecrets.ciphertext })
        .from(tenantSecrets)
        .where(and(eq(tenantSecrets.tenantId, tenantId), eq(tenantSecrets.name, name)));
      return row ? openSecret(row.c, tenantId) : undefined;
    });
    this.cache.set(key, { value, exp: Date.now() + 5 * 60_000 });
    return value;
  }

  async set(tenantId: string, name: SecretName, plaintext: string): Promise<void> {
    await this.db.withTenant(tenantId, (tx) =>
      tx
        .insert(tenantSecrets)
        .values({ tenantId, name, ciphertext: sealSecret(plaintext, tenantId) })
        .onConflictDoUpdate({ target: [tenantSecrets.tenantId, tenantSecrets.name], set: { ciphertext: sealSecret(plaintext, tenantId) } }),
    );
    this.cache.delete(`${tenantId}:${name}`);
  }

  async usesOwnLlmKeys(tenantId: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const [t] = await tx.select({ s: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
      return Boolean(t?.s.useOwnLlmKeys);
    });
  }
}
