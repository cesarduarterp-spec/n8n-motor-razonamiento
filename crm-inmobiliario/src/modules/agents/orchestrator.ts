import { type Content, type FunctionDeclaration } from '@google/genai';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { DelayedError, type Job, type Queue } from 'bullmq';
import { Decimal } from 'decimal.js';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { type AgentJob, defaultJobOptions, type OutboundJob, Q } from '../../common/queue/queues.js';
import { RedisLock } from '../../common/queue/redis.js';
import { StorageService } from '../../common/storage.js';
import { DatabaseService } from '../../database/database.service.js';
import {
  agentDrafts,
  contractParties,
  conversations,
  leads,
  messages,
  paymentReceipts,
  paymentSchedules,
} from '../../database/schema.js';
import { PropertiesService } from '../properties/properties.service.js';
import type { Classification, ReceiptExtraction } from './agent.schemas.js';
import { ClaudeSpecialist } from './claude-specialist.service.js';
import { GeminiFrontline } from './gemini-frontline.service.js';
import { type AgentContext, MemoryService } from './memory.service.js';
import { route } from './router.js';

type MessageRow = typeof messages.$inferSelect;

const SUMMARIZE_EVERY = 10;

const FRONTLINE_SYSTEM = `Sos el asistente virtual de una inmobiliaria argentina. Respondés por WhatsApp e Instagram en
español rioplatense, con mensajes breves (máx. 3-4 oraciones), cálidos y concretos.
- Para buscar propiedades usá SIEMPRE la herramienta search_properties; nunca inventes inmuebles, precios ni direcciones.
- Para saldos, vencimientos o comprobantes usá get_account_status.
- Si el contacto quiere visitar un inmueble usá request_visit; un asesor confirma día y horario.
- No das asesoramiento legal ni negociás condiciones: si surge, decí que un asesor lo va a contactar.
- Si no tenés la información, decilo y ofrecé derivar a un asesor.`;

const FRONTLINE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'search_properties',
    description: 'Busca inmuebles disponibles en la cartera de la inmobiliaria (búsqueda semántica + filtros).',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Descripción libre de lo que busca el contacto' },
        operation: { type: 'string', enum: ['sale', 'rent', 'temporary_rent'] },
        neighborhood: { type: 'string' },
        maxPrice: { type: 'number' },
        currency: { type: 'string', enum: ['ARS', 'USD'] },
        minBedrooms: { type: 'integer' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_account_status',
    description: 'Devuelve próximas cuotas, saldos y moras de los contratos del contacto.',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'request_visit',
    description: 'Registra el pedido de visita a un inmueble para que un asesor lo confirme.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        propertyCode: { type: 'string' },
        preferredTimes: { type: 'string', description: 'Días/horarios que propone el contacto' },
      },
      required: ['propertyCode'],
    },
  },
];

/**
 * Orquestador agéntico híbrido. Un turno = todos los mensajes entrantes de la
 * conversación sin respuesta todavía (debounce en la cola).
 *
 *   enriquecer (Gemini: audio→texto, imagen→comprobante) → clasificar (Gemini)
 *   → enrutar (reglas) → responder (Gemini con tools) | especialista (Claude)
 *   → salida (cola outbound) / borrador para aprobación humana → memoria
 *
 * Las llamadas a LLM nunca ocurren dentro de una transacción de BD.
 */
@Injectable()
export class AgentOrchestrator {
  private readonly log = new Logger(AgentOrchestrator.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly gemini: GeminiFrontline,
    private readonly claude: ClaudeSpecialist,
    private readonly memory: MemoryService,
    private readonly properties: PropertiesService,
    private readonly storage: StorageService,
    @InjectQueue(Q.OUTBOUND) private readonly outbound: Queue<OutboundJob>,
  ) {}

  async handleTurn(job: AgentJob): Promise<{ route: string; intent?: string }> {
    const { tenantId, conversationId, contactId } = job;

    const { pending, conversation } = await this.db.withTenant(tenantId, async (tx) => {
      const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
      const [lastOut] = await tx
        .select({ at: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      const rows = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.direction, 'inbound'),
            sql`${messages.intent} is null`,
            lastOut ? gt(messages.createdAt, lastOut.at) : undefined,
          ),
        )
        .orderBy(asc(messages.createdAt))
        .limit(10);
      return { pending: rows, conversation: conv };
    });

    if (!conversation || conversation.humanTakeover || pending.length === 0) return { route: 'skip' };

    // 1) Enriquecimiento multimodal (Gemini).
    const texts: string[] = [];
    let receiptNote: string | undefined;
    for (const m of pending) {
      const enriched = await this.enrich(tenantId, contactId, m);
      if (enriched.text) texts.push(enriched.text);
      if (enriched.receiptNote) receiptNote = enriched.receiptNote;
    }
    const latestText = texts.join('\n') || '[adjunto sin texto]';

    // 2) Contexto + clasificación.
    const ctx = await this.db.withTenant(tenantId, (tx) => this.memory.load(tx, tenantId, contactId));
    const digest = `${ctx.memory.summary}\n${this.memory.transcript(ctx).slice(-3000)}`;
    const classification = receiptNote
      ? receiptClassification()
      : await this.gemini.classify(tenantId, digest, latestText);

    const isTenantOrLandlord = ctx.contractIds.length > 0 || ctx.contact.kinds.some((k) => k === 'tenant' || k === 'landlord');
    const decision = route(classification, latestText, { isTenantOrLandlord });

    // 3) Respuesta según el motor.
    if (decision.engine === 'human') {
      await this.db.withTenant(tenantId, (tx) =>
        tx.update(conversations).set({ humanTakeover: true }).where(eq(conversations.id, conversationId)),
      );
      await this.send(tenantId, conversationId, 'agent_gemini', 'Perfecto, te paso con una persona del equipo. En breve te escriben por acá.');
    } else if (decision.engine === 'claude') {
      await this.specialist(tenantId, conversationId, ctx, classification, latestText);
    } else {
      const reply = receiptNote ?? (await this.frontline(tenantId, contactId, ctx, latestText));
      if (reply) await this.send(tenantId, conversationId, 'agent_gemini', reply);
    }

    // 4) Marcar mensajes procesados y actualizar memoria.
    await this.db.withTenant(tenantId, async (tx) => {
      await tx
        .update(messages)
        .set({ intent: classification.intent })
        .where(inArray(messages.id, pending.map((m) => m.id)));
      if (classification.intent === 'property_search' || classification.intent === 'visit_request') {
        await tx
          .update(leads)
          .set({ stage: classification.intent === 'visit_request' ? 'visit_scheduled' : 'contacted', requirements: classification.entities })
          .where(and(eq(leads.contactId, contactId), inArray(leads.stage, ['new', 'contacted'])));
      }
    });
    await this.maybeSummarize(tenantId, contactId, pending.length + 1);

    this.log.log(`turno ${conversationId}: ${classification.intent} → ${decision.engine}`);
    return { route: decision.engine, intent: classification.intent };
  }

  // ───────────── Enriquecimiento ─────────────

  private async enrich(tenantId: string, contactId: string, m: MessageRow): Promise<{ text?: string; receiptNote?: string }> {
    if (!m.mediaPath || !m.mediaMime) return { text: m.body ?? undefined };
    const file = await this.storage.get(tenantId, m.mediaPath);

    if (m.kind === 'audio') {
      const transcript = await this.gemini.transcribe(tenantId, file, m.mediaMime);
      await this.saveEnrichment(tenantId, m.id, { transcript });
      return { text: transcript };
    }

    if (m.kind === 'image' || (m.kind === 'document' && m.mediaMime === 'application/pdf')) {
      const receipt = await this.gemini.readReceipt(tenantId, file, m.mediaMime);
      if (receipt.isPaymentReceipt) {
        const note = await this.registerReceipt(tenantId, contactId, m, receipt);
        await this.saveEnrichment(tenantId, m.id, { receipt });
        return { text: m.body ?? '[comprobante de pago]', receiptNote: note };
      }
      const description = m.kind === 'image' ? await this.gemini.describeImage(tenantId, file, m.mediaMime) : '';
      await this.saveEnrichment(tenantId, m.id, { description });
      return { text: [m.body, description && `[imagen: ${description}]`].filter(Boolean).join(' ') };
    }
    return { text: m.body ?? undefined };
  }

  private saveEnrichment(tenantId: string, messageId: string, data: Record<string, unknown>) {
    return this.db.withTenant(tenantId, (tx) =>
      tx
        .update(messages)
        .set({ enrichment: sql`coalesce(${messages.enrichment}, '{}'::jsonb) || ${JSON.stringify(data)}::jsonb` })
        .where(eq(messages.id, messageId)),
    );
  }

  /**
   * Registra el comprobante y lo asocia a la cuota impaga que mejor coincide.
   * La cuota pasa a `under_review`: un humano confirma el pago (nunca se
   * marca `paid` automáticamente a partir de una imagen).
   */
  private async registerReceipt(tenantId: string, contactId: string, m: MessageRow, r: ReceiptExtraction): Promise<string> {
    return this.db.withTenant(tenantId, async (tx) => {
      const contractIds = (
        await tx
          .select({ id: contractParties.contractId })
          .from(contractParties)
          .where(and(eq(contractParties.contactId, contactId), eq(contractParties.role, 'tenant')))
      ).map((p) => p.id);

      const open = contractIds.length
        ? await tx
            .select()
            .from(paymentSchedules)
            .where(
              and(
                inArray(paymentSchedules.contractId, contractIds),
                inArray(paymentSchedules.status, ['pending', 'overdue', 'partial']),
              ),
            )
            .orderBy(asc(paymentSchedules.dueDate))
            .limit(6)
        : [];

      const amount = r.amount != null ? new Decimal(r.amount) : undefined;
      const match =
        (amount &&
          open.find((s) => {
            const due = new Decimal(s.amount).plus(s.penaltyAmount).minus(s.paidAmount);
            return due.minus(amount).abs().lte(due.mul(0.01));
          })) ??
        open[0];

      await tx.insert(paymentReceipts).values({
        tenantId,
        scheduleId: match?.id,
        contactId,
        messageId: m.id,
        amount: amount?.toFixed(2),
        paidOn: r.paidOn,
        operationNumber: r.operationNumber,
        payerName: r.payerName,
        bank: r.bank,
        mediaPath: m.mediaPath,
        extraction: r,
      });
      if (match) await tx.update(paymentSchedules).set({ status: 'under_review' }).where(eq(paymentSchedules.id, match.id));

      if (r.legibility === 'illegible') return 'Recibimos la imagen pero no se lee bien. ¿Podés enviarla de nuevo, más nítida?';
      const monto = amount ? ` por $${amount.toNumber().toLocaleString('es-AR')}` : '';
      return match
        ? `¡Gracias! Recibimos tu comprobante${monto}. Lo imputamos a la cuota con vencimiento ${match.dueDate} y administración lo confirma en las próximas horas.`
        : `¡Gracias! Recibimos tu comprobante${monto}. Un asesor lo va a imputar y te confirma.`;
    });
  }

  // ───────────── Motores ─────────────

  private async frontline(tenantId: string, contactId: string, ctx: AgentContext, latestText: string): Promise<string> {
    const history: Content[] = ctx.history.slice(-12).map((h) => ({
      role: h.direction === 'inbound' ? 'user' : 'model',
      parts: [{ text: h.text }],
    }));
    // El último turno del usuario debe incluir el texto enriquecido (transcripciones, etc.).
    if (history.at(-1)?.role !== 'user') history.push({ role: 'user', parts: [{ text: latestText }] });
    else history[history.length - 1] = { role: 'user', parts: [{ text: latestText }] };

    const system = `${FRONTLINE_SYSTEM}\n\nLo que sabemos del contacto:\n${ctx.memory.summary || '(nuevo contacto)'}\n${JSON.stringify(ctx.memory.facts)}`;

    return this.gemini.converse(tenantId, system, history, FRONTLINE_TOOLS, async (name, args) => {
      switch (name) {
        case 'search_properties':
          return this.properties.search(tenantId, { ...args, limit: 3 } as Parameters<PropertiesService['search']>[1]);
        case 'get_account_status':
          return this.db.withTenant(tenantId, (tx) =>
            tx
              .select({
                due: paymentSchedules.dueDate,
                amount: paymentSchedules.amount,
                paid: paymentSchedules.paidAmount,
                penalty: paymentSchedules.penaltyAmount,
                status: paymentSchedules.status,
              })
              .from(paymentSchedules)
              .where(
                and(
                  ctx.contractIds.length ? inArray(paymentSchedules.contractId, ctx.contractIds) : sql`false`,
                  inArray(paymentSchedules.status, ['pending', 'overdue', 'partial', 'under_review']),
                ),
              )
              .orderBy(asc(paymentSchedules.dueDate))
              .limit(3),
          );
        case 'request_visit':
          await this.db.withTenant(tenantId, (tx) =>
            tx
              .update(leads)
              .set({ stage: 'visit_scheduled', requirements: sql`${leads.requirements} || ${JSON.stringify({ visit: args })}::jsonb` })
              .where(eq(leads.contactId, contactId)),
          );
          return { ok: true, message: 'Pedido registrado; un asesor confirma día y horario.' };
        default:
          throw new Error(`Herramienta desconocida: ${name}`);
      }
    });
  }

  private async specialist(tenantId: string, conversationId: string, ctx: AgentContext, c: Classification, latestText: string) {
    const contractContext = await this.db.withTenant(tenantId, (tx) => this.memory.contractContext(tx, ctx.contractIds));
    const d = await this.claude.decide({
      tenantId,
      intent: c.intent,
      contactProfile: JSON.stringify({ name: ctx.contact.fullName, kinds: ctx.contact.kinds, facts: ctx.memory.facts }),
      memorySummary: ctx.memory.summary,
      transcript: this.memory.transcript(ctx),
      latestMessage: latestText,
      contractContext,
    });

    const contractId = ctx.contractIds[0];
    await this.db.withTenant(tenantId, async (tx) => {
      if (d.draft) {
        await tx.insert(agentDrafts).values({
          tenantId,
          conversationId,
          contractId,
          kind: d.draft.kind,
          content: d.draft.content,
          rationale: d.internalNote,
          riskLevel: d.riskLevel,
        });
      }
      if (!(d.autoSendReply && d.riskLevel !== 'high')) {
        await tx.insert(agentDrafts).values({
          tenantId,
          conversationId,
          contractId,
          kind: 'reply',
          content: d.replyToContact,
          rationale: d.internalNote,
          riskLevel: d.riskLevel,
        });
      }
    });

    if (d.autoSendReply && d.riskLevel !== 'high') {
      await this.send(tenantId, conversationId, 'agent_claude', d.replyToContact);
    } else {
      // Acuse neutral mientras un humano revisa la respuesta de fondo.
      await this.send(
        tenantId,
        conversationId,
        'agent_claude',
        'Gracias por escribirnos. Estamos revisando tu consulta con el equipo y te respondemos a la brevedad por este medio.',
      );
    }
  }

  private async maybeSummarize(tenantId: string, contactId: string, newMessages: number) {
    const count = await this.db.withTenant(tenantId, (tx) => this.memory.bump(tx, tenantId, contactId, newMessages));
    if (count < SUMMARIZE_EVERY) return;
    const ctx = await this.db.withTenant(tenantId, (tx) => this.memory.load(tx, tenantId, contactId));
    const update = await this.gemini.summarizeMemory(tenantId, ctx.memory.summary, this.memory.transcript(ctx));
    const facts = { ...ctx.memory.facts, ...Object.fromEntries(update.facts.map((f) => [f.key, f.value])) };
    await this.db.withTenant(tenantId, (tx) => this.memory.saveSummary(tx, tenantId, contactId, update.summary, facts));
  }

  private send(tenantId: string, conversationId: string, author: OutboundJob['author'], text: string) {
    return this.outbound.add('send', { tenantId, conversationId, text, author }, defaultJobOptions);
  }
}

function receiptClassification(): Classification {
  return {
    intent: 'payment_receipt',
    confidence: 1,
    sentiment: 'neutral',
    urgency: 'normal',
    legalRiskSignals: [],
    entities: { operation: null, propertyType: null, neighborhood: null, maxPrice: null, currency: null, bedrooms: null, propertyCode: null },
  };
}

@Processor(Q.AGENT, { concurrency: 8 })
export class AgentProcessor extends WorkerHost {
  constructor(
    private readonly orchestrator: AgentOrchestrator,
    private readonly lock: RedisLock,
  ) {
    super();
  }

  async process(job: Job<AgentJob>, token?: string) {
    // Un solo turno activo por conversación: si hay otro en curso, se re-agenda.
    const key = `conv:${job.data.conversationId}`;
    const lockToken = await this.lock.acquire(key, 120_000);
    if (!lockToken) {
      await job.moveToDelayed(Date.now() + 3_000, token);
      throw new DelayedError();
    }
    try {
      return await this.orchestrator.handleTurn(job.data);
    } finally {
      await this.lock.release(key, lockToken);
    }
  }
}
