import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { StorageService } from '../../common/storage.js';
import { DatabaseService, type TenantTx } from '../../database/database.service.js';
import { contacts, contractDocuments, contractParties, contracts, properties } from '../../database/schema.js';
import { LlmClients } from '../agents/llm-clients.js';
import { BillingService } from '../finance/billing.service.js';
import { ContractExtraction } from './extraction.schema.js';

const SYSTEM_PROMPT = `Sos un analista legal especializado en contratos de locación inmobiliaria en la República Argentina.
Tu tarea es leer el contrato adjunto (PDF o imágenes escaneadas) y devolver sus datos estructurados.

Marco normativo de referencia: Código Civil y Comercial de la Nación (arts. 1187 a 1226), Ley 27.551 (ICL, vigente para contratos firmados entre el 1/7/2020 y el 17/10/2023), Ley 27.737 (contratos firmados desde el 17/10/2023 hasta el 28/12/2023, índice Casa Propia) y DNU 70/2023 (desde el 29/12/2023: libertad de pactar plazo, moneda e índice de actualización).

Reglas:
- Transcribí fechas en formato YYYY-MM-DD. Si el contrato dice "a partir del primero de marzo de 2025", startDate = 2025-03-01.
- Montos como número sin separadores de miles (ej. "$ 450.000,50" → 450000.5).
- Si un dato no figura o es ilegible, devolvé null y agregalo a missingFields. Nunca inventes datos.
- adjustment.indexType: ICL si menciona el Índice para Contratos de Locación del BCRA; IPC si menciona el Índice de Precios al Consumidor del INDEC; CASA_PROPIA si menciona el coeficiente Casa Propia; FIXED si no hay actualización; OTHER para cualquier otro mecanismo (escalonado, dólar, mixto) y explicalo en legalRisks.
- En legalRisks señalá cláusulas ambiguas, contradictorias entre sí, abusivas o potencialmente nulas, y cualquier inconsistencia entre la fecha del contrato y el régimen legal aplicable. Citá la norma cuando corresponda.
- confidence refleja la legibilidad del documento y la certeza de la extracción.`;

export interface ExtractionOutcome {
  contractId: string;
  status: 'active' | 'needs_review';
  warnings: string[];
}

@Injectable()
export class ContractExtractionService {
  private readonly log = new Logger(ContractExtractionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly llm: LlmClients,
    private readonly storage: StorageService,
    private readonly billing: BillingService,
  ) {}

  async process(tenantId: string, documentId: string): Promise<ExtractionOutcome> {
    const doc = await this.db.withTenant(tenantId, async (tx) => {
      const [d] = await tx.select().from(contractDocuments).where(eq(contractDocuments.id, documentId));
      if (d) await tx.update(contractDocuments).set({ status: 'processing' }).where(eq(contractDocuments.id, documentId));
      return d;
    });
    if (!doc) throw new Error(`Documento ${documentId} no encontrado`);

    try {
      const file = await this.storage.get(tenantId, doc.storagePath);
      const extraction = await this.callClaude(tenantId, documentId, file, doc.mimeType);
      const warnings = validateExtraction(extraction);
      const outcome = await this.db.withTenant(tenantId, (tx) => this.persist(tx, tenantId, documentId, extraction, warnings));
      this.log.log(`Contrato ${outcome.contractId} creado (${outcome.status}) desde documento ${documentId}`);
      return outcome;
    } catch (err) {
      await this.db.withTenant(tenantId, (tx) =>
        tx
          .update(contractDocuments)
          .set({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
          .where(eq(contractDocuments.id, documentId)),
      );
      throw err;
    }
  }

  private async callClaude(tenantId: string, documentId: string, file: Buffer, mimeType: string): Promise<ContractExtraction> {
    const client = await this.llm.claude(tenantId);
    const data = file.toString('base64');
    const source: Anthropic.Beta.BetaContentBlockParam =
      mimeType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
        : {
            type: 'image',
            source: { type: 'base64', media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp', data },
          };

    const started = Date.now();
    const model = env().CLAUDE_MODEL;
    try {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 16000,
        // Si los clasificadores de seguridad rechazan, la API reintenta en el modelo de fallback adecuado.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: betaZodOutputFormat(ContractExtraction) },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [source, { type: 'text', text: 'Extraé los datos estructurados de este contrato de locación.' }],
          },
        ],
      });

      await this.llm.record({
        tenantId,
        engine: 'claude',
        model: response.model,
        task: 'contract_extraction',
        inputRef: documentId,
        prompt: { system: SYSTEM_PROMPT, user: `[${mimeType} ${file.length} bytes] Extraé los datos estructurados de este contrato de locación.` },
        rawResponse: { content: response.content, stop_reason: response.stop_reason },
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: Date.now() - started,
        outcome: response.stop_reason === 'refusal' ? 'refusal' : 'ok',
      });

      if (response.stop_reason === 'refusal') throw new Error('Claude declinó procesar el documento');
      if (response.stop_reason === 'max_tokens') throw new Error('Extracción truncada (max_tokens)');
      if (!response.parsed_output) throw new Error('La respuesta no cumplió el esquema de extracción');
      return response.parsed_output;
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        await this.llm.record({
          tenantId,
          engine: 'claude',
          model,
          task: 'contract_extraction',
          inputRef: documentId,
          latencyMs: Date.now() - started,
          outcome: 'error',
          detail: { status: err.status, message: err.message },
        });
        // 4xx (salvo 429) no se resuelve reintentando: falla definitiva del job.
        if (err.status && err.status < 500 && err.status !== 429) throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  /** Crea contrato + partes + cronograma en una única transacción (todo o nada). */
  private async persist(
    tx: TenantTx,
    tenantId: string,
    documentId: string,
    x: ContractExtraction,
    warnings: string[],
  ): Promise<ExtractionOutcome> {
    const status = warnings.length === 0 ? 'active' : 'needs_review';
    const indexType = x.adjustment.indexType === 'OTHER' ? 'FIXED' : x.adjustment.indexType;

    // Vincular el inmueble si ya existe en cartera (match por dirección).
    const [property] = await tx
      .select({ id: properties.id })
      .from(properties)
      .where(and(eq(properties.tenantId, tenantId), eq(properties.address, x.property.address)))
      .limit(1);

    const [contract] = await tx
      .insert(contracts)
      .values({
        tenantId,
        propertyId: property?.id,
        status,
        startDate: x.term.startDate,
        endDate: x.term.endDate,
        baseRent: x.rent.baseAmount.toFixed(2),
        currency: x.rent.currency,
        indexType,
        adjustmentFrequencyMonths: Math.max(0, x.adjustment.frequencyMonths),
        ipcLagMonths: x.adjustment.ipcLagMonths ?? 1,
        paymentDueDay: Math.min(Math.max(1, x.rent.paymentDueDay), 31),
        graceDays: x.latePayment.graceDays ?? 0,
        dailyPenaltyPct: (x.latePayment.dailyInterestPct ?? 0).toFixed(4),
        depositAmount: x.deposit ? x.deposit.amount.toFixed(2) : null,
        clauses: {
          adjustment: x.adjustment.clauseText,
          latePayment: x.latePayment.clauseText,
          guarantees: x.guarantees,
          earlyTermination: x.earlyTermination,
          expensesPaidBy: x.expensesPaidBy,
          legalRisks: x.legalRisks,
        },
        sourceDocumentId: documentId,
      })
      .returning();
    if (!contract) throw new Error('No se pudo crear el contrato');

    for (const p of x.parties) {
      const contactId = await this.upsertContact(tx, tenantId, p);
      await tx.insert(contractParties).values({ tenantId, contractId: contract.id, contactId, role: p.role }).onConflictDoNothing();
    }

    await this.billing.syncSchedule(tx, contract);

    await tx
      .update(contractDocuments)
      .set({ status: 'extracted', contractId: contract.id, extraction: x, warnings })
      .where(eq(contractDocuments.id, documentId));

    return { contractId: contract.id, status, warnings };
  }

  private async upsertContact(tx: TenantTx, tenantId: string, p: ContractExtraction['parties'][number]): Promise<string> {
    const kind = p.role === 'landlord' ? 'landlord' : p.role === 'tenant' ? 'tenant' : 'guarantor';
    if (p.documentNumber) {
      const [existing] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.documentId, p.documentNumber)));
      if (existing) return existing.id;
    }
    const [created] = await tx
      .insert(contacts)
      .values({
        tenantId,
        fullName: p.fullName,
        kinds: [kind],
        documentId: p.documentNumber,
        email: p.email,
        phoneE164: normalizeArPhone(p.phone),
      })
      .returning({ id: contacts.id });
    return created!.id;
  }
}

/** Reglas de negocio post-extracción. Cualquier advertencia deja el contrato en `needs_review`. */
export function validateExtraction(x: ContractExtraction): string[] {
  const w: string[] = [];
  if (x.confidence < 0.8) w.push(`Confianza baja (${x.confidence})`);
  if (x.term.endDate <= x.term.startDate) w.push('La fecha de fin no es posterior a la de inicio');
  if (x.rent.baseAmount <= 0) w.push('Canon inicial inválido');
  if (x.rent.paymentDueDay < 1 || x.rent.paymentDueDay > 31) w.push('Día de vencimiento inválido');
  if (x.adjustment.indexType === 'OTHER') w.push('Mecanismo de actualización no estándar: revisar manualmente');
  if (x.adjustment.indexType === 'CASA_PROPIA') w.push('Índice Casa Propia: requiere serie cargada');
  if (x.adjustment.indexType !== 'FIXED' && x.adjustment.frequencyMonths <= 0) w.push('Índice sin frecuencia de actualización');
  if (x.rent.currency !== 'ARS') w.push('Contrato en moneda extranjera');
  if (!x.parties.some((p) => p.role === 'landlord')) w.push('No se identificó locador');
  if (!x.parties.some((p) => p.role === 'tenant')) w.push('No se identificó locatario');
  for (const r of x.legalRisks.filter((r) => r.severity === 'high')) w.push(`Riesgo legal alto: ${r.issue}`);
  if (x.missingFields.length) w.push(`Campos faltantes: ${x.missingFields.join(', ')}`);
  return w;
}

/** Normaliza teléfonos argentinos a E.164 móvil (+549...). Devuelve null si no se puede. */
export function normalizeArPhone(raw: string | null): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('9')) d = d.slice(1);
  if (d.startsWith('0')) d = d.slice(1);
  // Formato local de celular: área (2-4) + "15" + abonado (6-8) = 12 dígitos → se quita el "15".
  if (d.length === 12) d = d.replace(/^(\d{2,4})15(\d{6,8})$/, '$1$2');
  return d.length === 10 ? `+549${d}` : null;
}
