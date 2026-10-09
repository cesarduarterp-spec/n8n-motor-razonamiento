import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { Injectable } from '@nestjs/common';
import { env } from '../../config/env.js';
import { DatabaseService } from '../../database/database.service.js';
import { agentRuns } from '../../database/schema.js';
import { TenantSecretsService } from '../tenants/tenant-secrets.service.js';

/**
 * Resuelve el cliente LLM de cada tenant: si la inmobiliaria trae sus propias
 * keys (settings.useOwnLlmKeys) se usan esas; si no, las globales de la
 * plataforma. Los clientes se cachean por API key.
 */
@Injectable()
export class LlmClients {
  private readonly anthropic = new Map<string, Anthropic>();
  private readonly gemini = new Map<string, GoogleGenAI>();

  constructor(
    private readonly secrets: TenantSecretsService,
    private readonly db: DatabaseService,
  ) {}

  private async keyFor(tenantId: string, name: 'anthropic_api_key' | 'gemini_api_key', fallback?: string) {
    const own = (await this.secrets.usesOwnLlmKeys(tenantId)) ? await this.secrets.get(tenantId, name) : undefined;
    const key = own ?? fallback;
    if (!key) throw new Error(`No hay ${name} configurada para el tenant ${tenantId}`);
    return key;
  }

  async claude(tenantId: string): Promise<Anthropic> {
    const key = await this.keyFor(tenantId, 'anthropic_api_key', env().ANTHROPIC_API_KEY);
    let client = this.anthropic.get(key);
    if (!client) {
      client = new Anthropic({ apiKey: key, maxRetries: 3, timeout: 5 * 60_000 });
      this.anthropic.set(key, client);
    }
    return client;
  }

  async geminiClient(tenantId: string): Promise<GoogleGenAI> {
    const key = await this.keyFor(tenantId, 'gemini_api_key', env().GEMINI_API_KEY);
    let client = this.gemini.get(key);
    if (!client) {
      client = new GoogleGenAI({ apiKey: key });
      this.gemini.set(key, client);
    }
    return client;
  }

  /** Registro de auditoría de cada invocación (modelo, tokens, latencia, resultado). */
  async record(run: typeof agentRuns.$inferInsert): Promise<void> {
    await this.db.withTenant(run.tenantId, (tx) => tx.insert(agentRuns).values(run)).catch(() => undefined);
  }
}
