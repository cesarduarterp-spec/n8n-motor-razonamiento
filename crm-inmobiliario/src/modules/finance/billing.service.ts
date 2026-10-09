import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { DatabaseService, type TenantTx } from '../../database/database.service.js';
import {
  contractAdjustments,
  contracts,
  indexRates,
  paymentReceipts,
  paymentSchedules,
  settlements,
  tenants,
} from '../../database/schema.js';
import { addMonths, todayIn, type IsoDate } from './dates.js';
import { fetchIclFromBcra, fetchIpcFromIndec, loadIndexSource, latestIndexDate } from './index-sources.js';
import { buildSchedule, computePenalty, computeSettlement, type ContractTerms, projectSchedule } from './rent-calculator.js';

type ContractRow = typeof contracts.$inferSelect;

export function termsOf(c: ContractRow): ContractTerms {
  return {
    startDate: c.startDate,
    endDate: c.endDate,
    baseRent: c.baseRent,
    indexType: c.indexType,
    adjustmentFrequencyMonths: c.adjustmentFrequencyMonths,
    ipcLagMonths: c.ipcLagMonths,
    paymentDueDay: c.paymentDueDay,
  };
}

@Injectable()
export class BillingService {
  private readonly log = new Logger(BillingService.name);

  constructor(private readonly db: DatabaseService) {}

  // ───────────── Ingesta de índices (global, rol SYSTEM) ─────────────

  async ingestIcl(): Promise<number> {
    const last = await latestIndexDate(this.db.system, 'ICL');
    const from = last ?? '2020-07-01'; // ICL vigente desde Ley 27.551
    const points = await fetchIclFromBcra(from, todayIn());
    return this.upsertIndex('ICL', points, 'BCRA');
  }

  async ingestIpc(): Promise<number> {
    return this.upsertIndex('IPC', await fetchIpcFromIndec(), 'INDEC');
  }

  private async upsertIndex(type: 'ICL' | 'IPC', points: { date: string; value: string }[], source: string) {
    if (points.length === 0) return 0;
    for (let i = 0; i < points.length; i += 1000) {
      await this.db.system
        .insert(indexRates)
        .values(points.slice(i, i + 1000).map((p) => ({ indexType: type, date: p.date, value: p.value, source })))
        .onConflictDoUpdate({
          target: [indexRates.indexType, indexRates.date],
          // INDEC puede revisar valores: se actualizan, quedando trazado en fetched_at.
          set: { value: sql`excluded.value`, fetchedAt: sql`now()` },
        });
    }
    this.log.log(`${type}: ${points.length} valores upsert`);
    return points.length;
  }

  async activeTenantIds(): Promise<string[]> {
    const rows = await this.db.system.select({ id: tenants.id }).from(tenants).where(eq(tenants.active, true));
    return rows.map((r) => r.id);
  }

  // ───────────── Cronograma (por tenant, bajo RLS) ─────────────

  /**
   * Crea o re-sincroniza el cronograma de un contrato. Solo modifica cuotas
   * `pending` (las pagadas/en revisión/en mora no se tocan) y registra cada
   * actualización aplicada en contract_adjustments.
   */
  async syncSchedule(tx: TenantTx, contract: ContractRow): Promise<void> {
    const src = await loadIndexSource(tx, contract.startDate, contract.endDate);
    const schedule = buildSchedule(termsOf(contract), src);

    let previousRent = new Decimal(contract.baseRent);
    for (const inst of schedule) {
      if (inst.adjustment) {
        await tx
          .insert(contractAdjustments)
          .values({
            tenantId: contract.tenantId,
            contractId: contract.id,
            effectiveDate: inst.adjustment.effectiveDate,
            previousRent: previousRent.toFixed(2),
            newRent: inst.adjustment.rent.toFixed(2),
            factor: inst.adjustment.factor.toDecimalPlaces(10).toString(),
            calculation: inst.adjustment.calculation,
          })
          .onConflictDoNothing();
      }
      previousRent = inst.amount;

      await tx
        .insert(paymentSchedules)
        .values({
          tenantId: contract.tenantId,
          contractId: contract.id,
          periodNumber: inst.periodNumber,
          periodMonth: inst.periodMonth,
          dueDate: inst.dueDate,
          amount: inst.amount.toFixed(2),
          provisional: inst.provisional,
        })
        .onConflictDoUpdate({
          target: [paymentSchedules.contractId, paymentSchedules.periodNumber],
          set: { amount: sql`excluded.amount`, provisional: sql`excluded.provisional` },
          setWhere: eq(paymentSchedules.status, 'pending'),
        });
    }
  }

  /** Recalcula los contratos activos con cuotas provisionales (corre tras cada ingesta de índices). */
  async applyAdjustments(tenantId: string): Promise<number> {
    return this.db.withTenant(tenantId, async (tx) => {
      const pendingContracts = await tx
        .selectDistinct({ contract: contracts })
        .from(contracts)
        .innerJoin(paymentSchedules, eq(paymentSchedules.contractId, contracts.id))
        .where(and(eq(contracts.status, 'active'), eq(paymentSchedules.provisional, true)));
      for (const { contract } of pendingContracts) await this.syncSchedule(tx, contract);
      return pendingContracts.length;
    });
  }

  /** Marca cuotas vencidas como mora y actualiza punitorios devengados a hoy. */
  async markOverdue(tenantId: string, asOf: IsoDate = todayIn()): Promise<number> {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({ s: paymentSchedules, c: contracts })
        .from(paymentSchedules)
        .innerJoin(contracts, eq(contracts.id, paymentSchedules.contractId))
        .where(
          and(
            inArray(paymentSchedules.status, ['pending', 'partial', 'overdue']),
            lt(paymentSchedules.dueDate, asOf),
          ),
        );
      let updated = 0;
      for (const { s, c } of rows) {
        const outstanding = new Decimal(s.amount).minus(s.paidAmount);
        const { daysLate, penalty } = computePenalty({
          outstanding,
          dueDate: s.dueDate,
          asOf,
          graceDays: c.graceDays,
          dailyPenaltyPct: c.dailyPenaltyPct,
        });
        if (daysLate <= c.graceDays) continue;
        await tx
          .update(paymentSchedules)
          .set({ status: 'overdue', penaltyAmount: penalty.toFixed(2) })
          .where(eq(paymentSchedules.id, s.id));
        updated++;
      }
      return updated;
    });
  }

  /** Liquidación mensual a locadores de todos los contratos activos del tenant. */
  async settleMonth(tenantId: string, periodMonth: IsoDate): Promise<number> {
    return this.db.withTenant(tenantId, async (tx) => {
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId));
      const rows = await tx
        .select({ s: paymentSchedules, c: contracts })
        .from(paymentSchedules)
        .innerJoin(contracts, eq(contracts.id, paymentSchedules.contractId))
        .where(and(eq(paymentSchedules.periodMonth, periodMonth), inArray(paymentSchedules.status, ['paid', 'partial'])));

      for (const { s, c } of rows) {
        const pct = c.agencyCommissionPct ?? String(tenant?.settings.agencyCommissionPct ?? 0);
        const st = computeSettlement({ collected: s.paidAmount, penalties: s.penaltyAmount, commissionPct: pct });
        await tx
          .insert(settlements)
          .values({
            tenantId,
            contractId: c.id,
            periodMonth,
            collected: st.collected.toFixed(2),
            penalties: st.penalties.toFixed(2),
            commission: st.commission.toFixed(2),
            otherDeductions: st.otherDeductions.toFixed(2),
            netToLandlord: st.netToLandlord.toFixed(2),
            detail: { scheduleId: s.id, commissionPct: String(pct) },
          })
          .onConflictDoNothing();
      }
      return rows.length;
    });
  }

  /**
   * Confirmación humana de un comprobante: imputa el monto a la cuota. Queda
   * en el audit trail como PAYMENT_EXEC (cuota y comprobante, con old/new).
   */
  async confirmReceipt(tenantId: string, receiptId: string, userId: string, amountOverride?: number) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [receipt] = await tx.select().from(paymentReceipts).where(eq(paymentReceipts.id, receiptId)).for('update');
      if (!receipt) throw new NotFoundException('Comprobante inexistente');
      if (receipt.verified) throw new ConflictException('El comprobante ya fue confirmado');
      if (!receipt.scheduleId) throw new ConflictException('El comprobante no está imputado a ninguna cuota');
      const amount = new Decimal(amountOverride ?? receipt.amount ?? 0);
      if (amount.lte(0)) throw new ConflictException('Monto inválido');

      const [s] = await tx.select().from(paymentSchedules).where(eq(paymentSchedules.id, receipt.scheduleId)).for('update');
      if (!s) throw new NotFoundException('Cuota inexistente');
      const paid = new Decimal(s.paidAmount).plus(amount);
      const due = new Decimal(s.amount).plus(s.penaltyAmount);

      await tx
        .update(paymentReceipts)
        .set({ verified: true, verifiedBy: userId, amount: amount.toFixed(2) })
        .where(eq(paymentReceipts.id, receiptId));
      const [updated] = await tx
        .update(paymentSchedules)
        .set({ paidAmount: paid.toFixed(2), status: paid.gte(due) ? 'paid' : 'partial', paidAt: new Date() })
        .where(eq(paymentSchedules.id, s.id))
        .returning();
      return updated;
    });
  }

  /** Proyección de cobros futuros de un contrato con un escenario de inflación mensual. */
  async projection(tenantId: string, contractId: string, assumedMonthlyInflationPct: number) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [contract] = await tx.select().from(contracts).where(eq(contracts.id, contractId));
      if (!contract) return undefined;
      const src = await loadIndexSource(tx, contract.startDate, contract.endDate);
      const terms = termsOf(contract);
      return projectSchedule(buildSchedule(terms, src), terms, assumedMonthlyInflationPct).map((i) => ({
        periodNumber: i.periodNumber,
        periodMonth: i.periodMonth,
        dueDate: i.dueDate,
        amount: i.amount.toFixed(2),
        provisional: i.provisional,
        projectedAmount: i.projectedAmount.toFixed(2),
      }));
    });
  }

  async upcomingDue(tenantId: string, from: IsoDate) {
    return this.db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(paymentSchedules)
        .where(and(gte(paymentSchedules.dueDate, from), lt(paymentSchedules.dueDate, addMonths(from, 1))))
        .orderBy(paymentSchedules.dueDate),
    );
  }
}
