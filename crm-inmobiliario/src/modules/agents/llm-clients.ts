import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { Injectable } from '@nestjs/common';
import { env } from '../../config/env.js';
import { DatabaseService } from '../../database/database.service.js';
import { aiDecisionLogs } from '../../database/schema.js';
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

  /**
   * Log inmutable de cada decisión de IA (prompt, tools, respuesta cruda,
   * tokens, ruteo). Un trigger replica una entrada AI_INTERACTION en el
   * audit trail encadenado. Fail-closed: si el log no se puede escribir, la
   * operación falla (y el job se reintenta) en lugar de actuar sin traza.
   */
  async record(run: AiDecisionInput): Promise<void> {
    await this.db.withTenant(run.tenantId, (tx) => tx.insert(aiDecisionLogs).values(run));
  }
}

export type AiDecisionInput = typeof aiDecisionLogs.$inferInsert;

/** Correlación de una llamada LLM con la conversación y el motivo de ruteo. */
export interface AiTrace {
  conversationId?: string;
  messageId?: string;
  routingReason?: string;
}

/** Reemplaza binarios por un descriptor (no se guardan audios/imágenes dentro del log). */
export function redactBinary(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) =>
      (key === 'data' || key === 'inlineData') && typeof v === 'string' && v.length > 256 ? `<base64 ${v.length} chars>` : v,
    ),
  );
}
