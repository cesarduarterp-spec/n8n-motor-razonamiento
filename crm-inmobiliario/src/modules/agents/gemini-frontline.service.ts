import { type Content, type FunctionDeclaration, type Part } from '@google/genai';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { LlmClients } from './llm-clients.js';
import { Classification, MemoryUpdate, ReceiptExtraction } from './agent.schemas.js';

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Motor frontline (Gemini): baja latencia y multimodal. Responsable de
 * clasificar, transcribir audios, leer comprobantes, responder consultas de
 * catálogo con function calling, resumir memoria y generar embeddings.
 */
@Injectable()
export class GeminiFrontline {
  constructor(private readonly llm: LlmClients) {}

  private get model() {
    return env().GEMINI_MODEL;
  }

  /** generateContent con salida JSON validada por Zod (el schema se envía como JSON Schema). */
  private async structured<S extends z.ZodType>(
    tenantId: string,
    task: string,
    schema: S,
    system: string,
    parts: Part[],
  ): Promise<z.infer<S>> {
    const ai = await this.llm.geminiClient(tenantId);
    const started = Date.now();
    const res = await ai.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: system,
        responseMimeType: 'application/json',
        responseJsonSchema: z.toJSONSchema(schema),
        temperature: 0.1,
      },
    });
    await this.llm.record({
      tenantId,
      engine: 'gemini',
      model: this.model,
      task,
      inputTokens: res.usageMetadata?.promptTokenCount,
      outputTokens: res.usageMetadata?.candidatesTokenCount,
      latencyMs: Date.now() - started,
      outcome: res.text ? 'ok' : 'error',
    });
    if (!res.text) throw new Error(`Gemini (${task}) devolvió respuesta vacía`);
    return schema.parse(JSON.parse(res.text));
  }

  classify(tenantId: string, conversationDigest: string, latestText: string): Promise<Classification> {
    return this.structured(
      tenantId,
      'classify',
      Classification,
      `Clasificás mensajes entrantes de clientes de una inmobiliaria argentina (interesados, inquilinos y propietarios).
Elegí UNA intención. Usá contract_claim, legal_dispute, renegotiation o delinquency ante cualquier señal de conflicto
contractual, reclamo de dinero, amenaza legal (carta documento, abogado, desalojo, intimación), pedido de rebaja/rescisión
o anuncio de que no se podrá pagar. En la duda entre una intención comercial y una legal, elegí la legal.`,
      [{ text: `Contexto reciente:\n${conversationDigest}\n\nÚltimo mensaje del contacto:\n${latestText}` }],
    );
  }

  /** Transcripción de notas de voz (WhatsApp envía audio/ogg; opus). */
  async transcribe(tenantId: string, audio: Buffer, mimeType: string): Promise<string> {
    const ai = await this.llm.geminiClient(tenantId);
    const res = await ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: mimeType.split(';')[0]!, data: audio.toString('base64') } },
            { text: 'Transcribí literalmente este audio en español rioplatense. Devolvé solo la transcripción.' },
          ],
        },
      ],
      config: { temperature: 0 },
    });
    return res.text?.trim() ?? '';
  }

  readReceipt(tenantId: string, image: Buffer, mimeType: string): Promise<ReceiptExtraction> {
    return this.structured(
      tenantId,
      'read_receipt',
      ReceiptExtraction,
      `Analizás imágenes enviadas por inquilinos. Determiná si es un comprobante de pago (transferencia bancaria,
Mercado Pago, depósito, etc.) y extraé sus datos. No inventes: si un dato no se lee, devolvé null.`,
      [{ inlineData: { mimeType: mimeType.split(';')[0]!, data: image.toString('base64') } }, { text: 'Extraé los datos.' }],
    );
  }

  /** Describe una imagen que no es comprobante (foto de una rotura, de un aviso, etc.). */
  async describeImage(tenantId: string, image: Buffer, mimeType: string): Promise<string> {
    const ai = await this.llm.geminiClient(tenantId);
    const res = await ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: mimeType.split(';')[0]!, data: image.toString('base64') } },
            { text: 'Describí en 2 oraciones qué muestra esta imagen, en el contexto de una inmobiliaria.' },
          ],
        },
      ],
    });
    return res.text?.trim() ?? '';
  }

  /**
   * Respuesta conversacional con function calling (catálogo, estado de
   * cuenta, visitas). Itera hasta que el modelo deja de pedir herramientas.
   */
  async converse(
    tenantId: string,
    system: string,
    history: Content[],
    tools: FunctionDeclaration[],
    execute: ToolExecutor,
    maxSteps = 4,
  ): Promise<string> {
    const ai = await this.llm.geminiClient(tenantId);
    const contents = [...history];
    for (let step = 0; step < maxSteps; step++) {
      const started = Date.now();
      const res = await ai.models.generateContent({
        model: this.model,
        contents,
        config: { systemInstruction: system, tools: [{ functionDeclarations: tools }], temperature: 0.4 },
      });
      await this.llm.record({
        tenantId,
        engine: 'gemini',
        model: this.model,
        task: 'converse',
        inputTokens: res.usageMetadata?.promptTokenCount,
        outputTokens: res.usageMetadata?.candidatesTokenCount,
        latencyMs: Date.now() - started,
        outcome: 'ok',
      });

      const calls = res.functionCalls ?? [];
      if (calls.length === 0) return res.text?.trim() ?? '';

      const modelContent = res.candidates?.[0]?.content;
      if (modelContent) contents.push(modelContent);
      const responses: Part[] = [];
      for (const call of calls) {
        let result: unknown;
        try {
          result = await execute(call.name ?? '', (call.args ?? {}) as Record<string, unknown>);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        responses.push({ functionResponse: { id: call.id, name: call.name, response: { result } } });
      }
      contents.push({ role: 'user', parts: responses });
    }
    return 'Dame un momento que lo consulto con un asesor y te escribimos enseguida.';
  }

  summarizeMemory(tenantId: string, previousSummary: string, transcript: string) {
    return this.structured(
      tenantId,
      'summarize_memory',
      MemoryUpdate,
      'Mantenés la memoria de largo plazo de un CRM inmobiliario. Integrá el resumen previo con la conversación nueva.',
      [{ text: `Resumen previo:\n${previousSummary || '(vacío)'}\n\nConversación nueva:\n${transcript}` }],
    );
  }

  /** Embedding normalizado (necesario al reducir dimensiones de gemini-embedding-001). */
  async embed(tenantId: string, text: string, taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'): Promise<number[]> {
    const ai = await this.llm.geminiClient(tenantId);
    const res = await ai.models.embedContent({
      model: env().GEMINI_EMBEDDING_MODEL,
      contents: text,
      config: { taskType, outputDimensionality: env().EMBEDDING_DIMENSIONS },
    });
    const values = res.embeddings?.[0]?.values;
    if (!values?.length) throw new Error('Embedding vacío');
    const norm = Math.hypot(...values) || 1;
    return values.map((v) => v / norm);
  }
}
