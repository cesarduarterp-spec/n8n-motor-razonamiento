import { Decimal } from 'decimal.js';
import { addDays, addMonths, daysInMonth, diffDays, firstOfMonth, parseIso, toIso, type IsoDate } from './dates.js';

/*
 * Motor de cálculo de alquileres — funciones puras, sin I/O, 100% testeables.
 *
 * ICL (Ley 27.551, Com. BCRA "A" 7096): índice diario.
 *   Canon_k = Canon_base × ICL(fecha_actualización_k) / ICL(fecha_inicio)
 *
 * IPC (INDEC, nivel general nacional): índice mensual.
 *   Variación acumulada entre el mes base y el mes anterior a la actualización.
 *   Con niveles de índice: factor = Nivel(mes_act − lag) / Nivel(mes_inicio − lag)
 *   que equivale a Π(1 + var_mensual_i) de los meses del período.
 *   `lag` = 1 por defecto (mes anterior); contratos que actualizan antes de la
 *   publicación del INDEC (≈ día 15) suelen pactar lag = 2.
 *
 * Siempre se calcula desde el canon base (no encadenando cánones redondeados)
 * para que el redondeo no acumule error período a período.
 */

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type IndexKind = 'ICL' | 'IPC' | 'FIXED' | 'CASA_PROPIA';

export class IndexNotAvailableError extends Error {
  constructor(
    readonly index: IndexKind,
    readonly date: IsoDate,
  ) {
    super(`Índice ${index} no disponible para ${date}`);
  }
}

/** Fuente de valores de índice. ICL por fecha exacta; IPC por primer día del mes. */
export interface IndexSource {
  get(index: 'ICL' | 'IPC', date: IsoDate): Decimal | undefined;
}

export interface ContractTerms {
  startDate: IsoDate;
  endDate: IsoDate;
  baseRent: Decimal.Value;
  indexType: IndexKind;
  adjustmentFrequencyMonths: number;
  ipcLagMonths?: number;
  paymentDueDay: number;
}

export interface AdjustmentResult {
  effectiveDate: IsoDate;
  factor: Decimal;
  rent: Decimal;
  calculation: Record<string, string>;
}

/** El ICL se publica para todos los días; si faltara uno, se toma el último anterior (máx. 7 días). */
function iclOnOrBefore(src: IndexSource, date: IsoDate): { date: IsoDate; value: Decimal } {
  for (let i = 0; i <= 7; i++) {
    const d = addDays(date, -i);
    const v = src.get('ICL', d);
    if (v) return { date: d, value: v };
  }
  throw new IndexNotAvailableError('ICL', date);
}

function ipcLevel(src: IndexSource, month: IsoDate): Decimal {
  const v = src.get('IPC', firstOfMonth(month));
  if (!v) throw new IndexNotAvailableError('IPC', firstOfMonth(month));
  return v;
}

/** Fechas de actualización: inicio + k × frecuencia, mientras sean anteriores al fin del contrato. */
export function adjustmentDates(terms: ContractTerms): IsoDate[] {
  if (terms.indexType === 'FIXED' || terms.adjustmentFrequencyMonths <= 0) return [];
  const out: IsoDate[] = [];
  for (let k = 1; ; k++) {
    const d = addMonths(terms.startDate, k * terms.adjustmentFrequencyMonths);
    if (d >= terms.endDate) break;
    out.push(d);
  }
  return out;
}

export function computeAdjustment(terms: ContractTerms, effectiveDate: IsoDate, src: IndexSource): AdjustmentResult {
  const base = new Decimal(terms.baseRent);

  switch (terms.indexType) {
    case 'FIXED':
      return { effectiveDate, factor: new Decimal(1), rent: base, calculation: { method: 'FIXED' } };

    case 'ICL': {
      const start = iclOnOrBefore(src, terms.startDate);
      const current = iclOnOrBefore(src, effectiveDate);
      const factor = current.value.div(start.value);
      return {
        effectiveDate,
        factor,
        rent: base.mul(factor).toDecimalPlaces(2),
        calculation: {
          method: 'ICL',
          formula: 'canon_base × ICL(actualización) / ICL(inicio)',
          baseRent: base.toFixed(2),
          iclStartDate: start.date,
          iclStart: start.value.toString(),
          iclCurrentDate: current.date,
          iclCurrent: current.value.toString(),
        },
      };
    }

    case 'IPC': {
      const lag = terms.ipcLagMonths ?? 1;
      const baseMonth = addMonths(firstOfMonth(terms.startDate), -lag);
      const lastMonth = addMonths(firstOfMonth(effectiveDate), -lag);
      const factor = ipcLevel(src, lastMonth).div(ipcLevel(src, baseMonth));
      return {
        effectiveDate,
        factor,
        rent: base.mul(factor).toDecimalPlaces(2),
        calculation: {
          method: 'IPC',
          formula: 'canon_base × Nivel(mes_act − lag) / Nivel(mes_inicio − lag)',
          baseRent: base.toFixed(2),
          lagMonths: String(lag),
          ipcBaseMonth: baseMonth,
          ipcBase: ipcLevel(src, baseMonth).toString(),
          ipcLastMonth: lastMonth,
          ipcLast: ipcLevel(src, lastMonth).toString(),
          accumulatedPct: factor.minus(1).mul(100).toFixed(4),
        },
      };
    }

    case 'CASA_PROPIA':
      // Coeficiente Casa Propia (Min. Desarrollo Territorial): requiere su propia serie.
      throw new Error('Índice CASA_PROPIA no soportado todavía: cargar la serie y extender IndexSource');
  }
}

/** Variación acumulada de IPC a partir de variaciones mensuales (%): Π(1 + v/100) − 1. */
export function accumulateMonthlyRates(monthlyPct: Decimal.Value[]): Decimal {
  return monthlyPct.reduce<Decimal>((acc, v) => acc.mul(new Decimal(v).div(100).plus(1)), new Decimal(1)).minus(1);
}

export interface Installment {
  periodNumber: number;
  periodMonth: IsoDate;
  dueDate: IsoDate;
  amount: Decimal;
  provisional: boolean;
  adjustment?: AdjustmentResult;
}

/**
 * Cronograma completo del contrato. Los períodos posteriores a una
 * actualización cuyo índice aún no se publicó quedan `provisional` con el
 * último canon conocido; el worker de billing los recalcula cuando el índice
 * está disponible.
 */
export function buildSchedule(terms: ContractTerms, src: IndexSource): Installment[] {
  const adjustments = adjustmentDates(terms);
  const installments: Installment[] = [];
  let currentRent = new Decimal(terms.baseRent);
  let provisional = false;
  let adjIdx = 0;

  for (let n = 0; ; n++) {
    const periodStart = addMonths(terms.startDate, n);
    if (periodStart >= terms.endDate) break;

    let appliedAdjustment: AdjustmentResult | undefined;
    const nextAdj = adjustments[adjIdx];
    if (nextAdj && periodStart >= nextAdj) {
      adjIdx++;
      try {
        appliedAdjustment = computeAdjustment(terms, nextAdj, src);
        currentRent = appliedAdjustment.rent;
        provisional = false;
      } catch (e) {
        if (!(e instanceof IndexNotAvailableError)) throw e;
        provisional = true; // se mantiene el último canon conocido
      }
    }

    const { y, m } = parseIso(firstOfMonth(periodStart));
    installments.push({
      periodNumber: n + 1,
      periodMonth: toIso(y, m, 1),
      dueDate: toIso(y, m, Math.min(terms.paymentDueDay, daysInMonth(y, m))),
      amount: currentRent,
      provisional,
      ...(appliedAdjustment ? { adjustment: appliedAdjustment } : {}),
    });
  }
  return installments;
}

/**
 * Interés punitorio simple diario sobre el saldo impago. Se devenga desde el
 * vencimiento, pero solo si el atraso supera los días de gracia.
 */
export function computePenalty(params: {
  outstanding: Decimal.Value;
  dueDate: IsoDate;
  asOf: IsoDate;
  graceDays: number;
  dailyPenaltyPct: Decimal.Value;
}): { daysLate: number; penalty: Decimal } {
  const daysLate = Math.max(0, diffDays(params.dueDate, params.asOf));
  if (daysLate <= params.graceDays) return { daysLate, penalty: new Decimal(0) };
  const penalty = new Decimal(params.outstanding)
    .mul(new Decimal(params.dailyPenaltyPct).div(100))
    .mul(daysLate)
    .toDecimalPlaces(2);
  return { daysLate, penalty };
}

/** Liquidación al locador: (cobrado + punitorios) − comisión − otras deducciones. */
export function computeSettlement(params: {
  collected: Decimal.Value;
  penalties: Decimal.Value;
  commissionPct: Decimal.Value;
  otherDeductions?: Decimal.Value;
}) {
  const collected = new Decimal(params.collected);
  const penalties = new Decimal(params.penalties);
  const gross = collected.plus(penalties);
  const commission = gross.mul(new Decimal(params.commissionPct).div(100)).toDecimalPlaces(2);
  const other = new Decimal(params.otherDeductions ?? 0);
  return {
    collected,
    penalties,
    commission,
    otherDeductions: other,
    netToLandlord: gross.minus(commission).minus(other).toDecimalPlaces(2),
  };
}

/**
 * Proyección de cobro para períodos futuros con índice no publicado,
 * asumiendo una inflación mensual estimada (escenario, no valor contractual).
 */
export function projectSchedule(
  schedule: Installment[],
  terms: ContractTerms,
  assumedMonthlyInflationPct: Decimal.Value,
): Array<Installment & { projectedAmount: Decimal }> {
  const monthly = new Decimal(assumedMonthlyInflationPct).div(100).plus(1);
  const freq = terms.adjustmentFrequencyMonths;
  let lastFirm = new Decimal(terms.baseRent);
  let lastFirmPeriod = 0;

  return schedule.map((inst) => {
    if (!inst.provisional) {
      lastFirm = inst.amount;
      lastFirmPeriod = inst.periodNumber;
      return { ...inst, projectedAmount: inst.amount };
    }
    // Meses transcurridos desde la última actualización firme hasta la actualización vigente del período.
    const monthsSinceFirm = freq > 0 ? Math.floor((inst.periodNumber - 1) / freq) * freq - Math.floor((lastFirmPeriod - 1) / freq) * freq : 0;
    return { ...inst, projectedAmount: lastFirm.mul(monthly.pow(monthsSinceFirm)).toDecimalPlaces(2) };
  });
}
