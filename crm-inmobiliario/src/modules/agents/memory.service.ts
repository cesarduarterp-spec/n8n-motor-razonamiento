import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { TenantTx } from '../../database/database.service.js';
import {
  contacts,
  contractAdjustments,
  contractParties,
  contracts,
  conversationMemory,
  conversations,
  messages,
  paymentSchedules,
} from '../../database/schema.js';

export interface AgentContext {
  contact: typeof contacts.$inferSelect;
  memory: { summary: string; facts: Record<string, unknown>; messagesSinceSummary: number };
  /** Historial unificado de TODOS los canales del contacto (omnicanal), más viejo primero. */
  history: Array<{ direction: 'inbound' | 'outbound'; author: string; channel: string; text: string; at: Date }>;
  contractIds: string[];
}

const HISTORY_WINDOW = 20;

/**
 * Memoria conversacional persistente por (tenant_id, contacto):
 * - corto plazo: últimos N mensajes de todos los canales;
 * - largo plazo: resumen rodante + hechos estructurados (conversation_memory).
 */
@Injectable()
export class MemoryService {
  async load(tx: TenantTx, tenantId: string, contactId: string): Promise<AgentContext> {
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, contactId));
    if (!contact) throw new Error(`Contacto ${contactId} inexistente`);

    const [mem] = await tx
      .select()
      .from(conversationMemory)
      .where(and(eq(conversationMemory.tenantId, tenantId), eq(conversationMemory.contactId, contactId)));

    const rows = await tx
      .select({
        direction: messages.direction,
        author: messages.author,
        channel: conversations.channel,
        body: messages.body,
        enrichment: messages.enrichment,
        at: messages.createdAt,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(conversations.contactId, contactId))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_WINDOW);

    const parties = await tx
      .select({ contractId: contractParties.contractId })
      .from(contractParties)
      .where(eq(contractParties.contactId, contactId));

    return {
      contact,
      memory: {
        summary: mem?.summary ?? '',
        facts: mem?.facts ?? {},
        messagesSinceSummary: mem?.messagesSinceSummary ?? 0,
      },
      history: rows.reverse().map((r) => ({
        direction: r.direction,
        author: r.author,
        channel: r.channel,
        text: r.body ?? String((r.enrichment as Record<string, unknown> | null)?.transcript ?? `[${r.channel}: adjunto]`),
        at: r.at,
      })),
      contractIds: parties.map((p) => p.contractId),
    };
  }

  /** Datos contractuales del contacto para el especialista (JSON compacto). */
  async contractContext(tx: TenantTx, contractIds: string[]): Promise<string> {
    if (contractIds.length === 0) return '(el contacto no tiene contratos vinculados)';
    const cs = await tx.select().from(contracts).where(inArray(contracts.id, contractIds));
    const schedule = await tx
      .select()
      .from(paymentSchedules)
      .where(
        and(
          inArray(paymentSchedules.contractId, contractIds),
          sql`${paymentSchedules.dueDate} <= (current_date + interval '45 days')`,
        ),
      )
      .orderBy(desc(paymentSchedules.dueDate))
      .limit(12);
    const adjustments = await tx
      .select()
      .from(contractAdjustments)
      .where(inArray(contractAdjustments.contractId, contractIds))
      .orderBy(desc(contractAdjustments.effectiveDate))
      .limit(6);

    return JSON.stringify(
      {
        contracts: cs.map((c) => ({
          id: c.id,
          status: c.status,
          start: c.startDate,
          end: c.endDate,
          baseRent: c.baseRent,
          currency: c.currency,
          index: c.indexType,
          adjustEveryMonths: c.adjustmentFrequencyMonths,
          dueDay: c.paymentDueDay,
          graceDays: c.graceDays,
          dailyPenaltyPct: c.dailyPenaltyPct,
          deposit: c.depositAmount,
          clauses: c.clauses,
        })),
        recentInstallments: schedule.map((s) => ({
          contractId: s.contractId,
          period: s.periodMonth,
          due: s.dueDate,
          amount: s.amount,
          paid: s.paidAmount,
          penalty: s.penaltyAmount,
          status: s.status,
          provisional: s.provisional,
        })),
        adjustments: adjustments.map((a) => ({
          contractId: a.contractId,
          effective: a.effectiveDate,
          from: a.previousRent,
          to: a.newRent,
          factor: a.factor,
          calculation: a.calculation,
        })),
      },
      null,
      1,
    );
  }

  transcript(ctx: AgentContext): string {
    return ctx.history
      .map((h) => `[${h.at.toISOString().slice(0, 16)} ${h.channel}] ${h.direction === 'inbound' ? 'Contacto' : h.author}: ${h.text}`)
      .join('\n');
  }

  async bump(tx: TenantTx, tenantId: string, contactId: string, by: number): Promise<number> {
    const [row] = await tx
      .insert(conversationMemory)
      .values({ tenantId, contactId, messagesSinceSummary: by })
      .onConflictDoUpdate({
        target: [conversationMemory.tenantId, conversationMemory.contactId],
        set: { messagesSinceSummary: sql`${conversationMemory.messagesSinceSummary} + ${by}` },
      })
      .returning({ n: conversationMemory.messagesSinceSummary });
    return row?.n ?? 0;
  }

  async saveSummary(tx: TenantTx, tenantId: string, contactId: string, summary: string, facts: Record<string, unknown>) {
    await tx
      .update(conversationMemory)
      .set({ summary, facts, messagesSinceSummary: 0 })
      .where(and(eq(conversationMemory.tenantId, tenantId), eq(conversationMemory.contactId, contactId)));
  }
}
