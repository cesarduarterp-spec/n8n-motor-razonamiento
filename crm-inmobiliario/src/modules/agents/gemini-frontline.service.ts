import { type Content, type FunctionDeclaration, type GenerateContentResponse, type Part } from '@google/genai';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { type AiTrace, LlmClients, redactBinary } from './llm-clients.js';
import { Classification, MemoryUpdate, ReceiptExtraction } from './agent.schemas.js';

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

type ToolTrace = { name: string; args: unknown; result?: unknown; error?: string };

/**
 * Motor frontline (Gemini): baja latencia y multimodal. Responsable de
 * clasificar, transcribir audios, leer comprobantes, responder consultas de
 * catálogo con function calling, resumir memoria y generar embeddings.
 * Cada llamada queda en ai_decision_logs con prompt, tools y respuesta cruda.
 */
@Injectable()
export class GeminiFrontline {
  constructor(private readonly llm: LlmClients) {}

  private get model() {
    return env().GEMINI_MODEL;
  }

  private async log(
    tenantId: string,
    task: string,
    trace: AiTrace | undefined,
    started: number,
    prompt: unknown,
    res: GenerateContentResponse | undefined,
    extra: { tools?: ToolTrace[]; outcome?: string; detail?: Record<string, unknown>; raw?: unknown } = {},
  ) {
    await this.llm.record({
      tenantId,
      engine: 'gemini',
      model: this.model,
      task,
      conversationId: trace?.conversationId,
      messageId: trace?.messageId,
      routingReason: trace?.routingReason,
      prompt: redactBinary(prompt),
      toolsInvoked: extra.tools,
      rawResponse: extra.raw ?? (res ? { candidates: res.candidates, promptFeedback: res.promptFeedback } : null),
      inputTokens: res?.usageMetadata?.promptTokenCount,
      outputTokens: res?.usageMetadata?.candidatesTokenCount,
      latencyMs: Date.now() - started,
      outcome: extra.outcome ?? (res?.text || res?.functionCalls?.length ? 'ok' : 'error'),
      detail: extra.detail,
    });
  }

  /** generateContent con salida JSON validada por Zod (el schema se envía como JSON Schema). */
  private async structured<S extends z.ZodType>(
    tenantId: string,
    task: string,
    schema: S,
    system: string,
    parts: Part[],
    trace?: AiTrace,
  ): Promise<z.infer<S>> {
    const ai = await this.llm.geminiClient(tenantId);
    const started = Date.now();
    const request = {
      model: this.model,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: system,
        responseMimeType: 'application/json',
        responseJsonSchema: z.toJSONSchema(schema),
        temperature: 0.1,
      },
    };
    const res = await ai.models.generateContent(request);
    await this.log(tenantId, task, trace, started, { system, parts }, res);
    if (!res.text) throw new Error(`Gemini (${task}) devolvió respuesta vacía`);
    return schema.parse(JSON.parse(res.text));
  }

  private async plain(tenantId: string, task: string, parts: Part[], trace?: AiTrace, temperature = 0): Promise<string> {
    const ai = await this.llm.geminiClient(tenantId);
    const started = Date.now();
    const res = await ai.models.generateContent({ model: this.model, contents: [{ role: 'user', parts }], config: { temperature } });
    await this.log(tenantId, task, trace, started, { parts }, res);
    return res.text?.trim() ?? '';
  }

  classify(tenantId: string, conversationDigest: string, latestText: string, trace?: AiTrace): Promise<Classification> {
    return this.structured(
      tenantId,
      'classify',
      Classification,
      `Clasificás mensajes entrantes de clientes de una inmobiliaria argentina (interesados, inquilinos y propietarios).
Elegí UNA intención. Usá contract_claim, legal_dispute, renegotiation o delinquency ante cualquier señal de conflicto
contractual, reclamo de dinero, amenaza legal (carta documento, abogado, desalojo, intimación), pedido de rebaja/rescisión
o anuncio de que no se podrá pagar. En la duda entre una intención comercial y una legal, elegí la legal.
En entities extraé también lo que el contacto busca (zona, tipo, presupuesto, dormitorios) si lo menciona.`,
      [{ text: `Contexto reciente:\n${conversationDigest}\n\nÚltimo mensaje del contacto:\n${latestText}` }],
      trace,
    );
  }

  /** Transcripción de notas de voz (WhatsApp envía audio/ogg; opus). */
  transcribe(tenantId: string, audio: Buffer, mimeType: string, trace?: AiTrace): Promise<string> {
    return this.plain(
      tenantId,
      'transcribe',
      [
        { inlineData: { mimeType: mimeType.split(';')[0]!, data: audio.toString('base64') } },
        { text: 'Transcribí literalmente este audio en español rioplatense. Devolvé solo la transcripción.' },
      ],
      trace,
    );
  }

  readReceipt(tenantId: string, image: Buffer, mimeType: string, trace?: AiTrace): Promise<ReceiptExtraction> {
    return this.structured(
      tenantId,
      'read_receipt',
      ReceiptExtraction,
      `Analizás imágenes enviadas por inquilinos. Determiná si es un comprobante de pago (transferencia bancaria,
Mercado Pago, depósito, etc.) y extraé sus datos. No inventes: si un dato no se lee, devolvé null.`,
      [{ inlineData: { mimeType: mimeType.split(';')[0]!, data: image.toString('base64') } }, { text: 'Extraé los datos.' }],
      trace,
    );
  }

  /** Describe una imagen que no es comprobante (foto de una rotura, de un aviso, etc.). */
  describeImage(tenantId: string, image: Buffer, mimeType: string, trace?: AiTrace): Promise<string> {
    return this.plain(
      tenantId,
      'describe_image',
      [
        { inlineData: { mimeType: mimeType.split(';')[0]!, data: image.toString('base64') } },
        { text: 'Describí en 2 oraciones qué muestra esta imagen, en el contexto de una inmobiliaria.' },
      ],
      trace,
      0.2,
    );
  }

  /**
   * Respuesta conversacional con function calling (catálogo, estado de
   * cuenta, agenda de visitas). Itera hasta que el modelo deja de pedir
   * herramientas y registra UNA entrada con todo el recorrido.
   */
  async converse(
    tenantId: string,
    system: string,
    history: Content[],
    tools: FunctionDeclaration[],
    execute: ToolExecutor,
    trace?: AiTrace,
    maxSteps = 5,
  ): Promise<string> {
    const ai = await this.llm.geminiClient(tenantId);
    const contents = [...history];
    const toolTrace: ToolTrace[] = [];
    const steps: unknown[] = [];
    const started = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let finalText: string | undefined;

    for (let step = 0; step < maxSteps && finalText === undefined; step++) {
      const res = await ai.models.generateContent({
        model: this.model,
        contents,
        config: { systemInstruction: system, tools: [{ functionDeclarations: tools }], temperature: 0.4 },
      });
      inputTokens += res.usageMetadata?.promptTokenCount ?? 0;
      outputTokens += res.usageMetadata?.candidatesTokenCount ?? 0;
      steps.push(res.candidates?.[0]?.content ?? null);

      const calls = res.functionCalls ?? [];
      if (calls.length === 0) {
        finalText = res.text?.trim() ?? '';
        break;
      }
      const modelContent = res.candidates?.[0]?.content;
      if (modelContent) contents.push(modelContent);
      const responses: Part[] = [];
      for (const call of calls) {
        const args = (call.args ?? {}) as Record<string, unknown>;
        const entry: ToolTrace = { name: call.name ?? '', args };
        try {
          entry.result = await execute(entry.name, args);
        } catch (err) {
          entry.error = err instanceof Error ? err.message : String(err);
        }
        toolTrace.push(entry);
        responses.push({
          functionResponse: { id: call.id, name: call.name, response: entry.error ? { error: entry.error } : { result: entry.result } },
        });
      }
      contents.push({ role: 'user', parts: responses });
    }

    const reply = finalText ?? 'Dame un momento que lo consulto con un asesor y te escribimos enseguida.';
    await this.llm.record({
      tenantId,
      engine: 'gemini',
      model: this.model,
      task: 'converse',
      conversationId: trace?.conversationId,
      messageId: trace?.messageId,
      routingReason: trace?.routingReason,
      prompt: redactBinary({ system, history, tools: tools.map((t) => t.name) }),
      toolsInvoked: toolTrace,
      rawResponse: { steps, reply },
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - started,
      outcome: finalText === undefined ? 'max_steps' : 'ok',
    });
    return reply;
  }

  summarizeMemory(tenantId: string, previousSummary: string, transcript: string, trace?: AiTrace) {
    return this.structured(
      tenantId,
      'summarize_memory',
      MemoryUpdate,
      'Mantenés la memoria de largo plazo de un CRM inmobiliario. Integrá el resumen previo con la conversación nueva.',
      [{ text: `Resumen previo:\n${previousSummary || '(vacío)'}\n\nConversación nueva:\n${transcript}` }],
      trace,
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
