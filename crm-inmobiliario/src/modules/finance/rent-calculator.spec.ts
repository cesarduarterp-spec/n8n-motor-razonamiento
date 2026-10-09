import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { addMonths } from './dates.js';
import {
  accumulateMonthlyRates,
  buildSchedule,
  computeAdjustment,
  computePenalty,
  computeSettlement,
  type ContractTerms,
  type IndexSource,
  IndexNotAvailableError,
  projectSchedule,
} from './rent-calculator.js';

function source(icl: Record<string, number>, ipc: Record<string, number>): IndexSource {
  return {
    get: (index, date) => {
      const v = (index === 'ICL' ? icl : ipc)[date];
      return v === undefined ? undefined : new Decimal(v);
    },
  };
}

describe('dates', () => {
  it('respeta fin de mes', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
    expect(addMonths('2025-11-15', 3)).toBe('2026-02-15');
  });
});

describe('ICL', () => {
  const terms: ContractTerms = {
    startDate: '2024-03-01',
    endDate: '2027-03-01',
    baseRent: '300000',
    indexType: 'ICL',
    adjustmentFrequencyMonths: 12,
    paymentDueDay: 10,
  };

  it('canon = base × ICL(act) / ICL(inicio)', () => {
    const src = source({ '2024-03-01': 8.5, '2025-03-01': 17 }, {});
    const r = computeAdjustment(terms, '2025-03-01', src);
    expect(r.factor.toString()).toBe('2');
    expect(r.rent.toFixed(2)).toBe('600000.00');
  });

  it('usa el último valor anterior si falta el día exacto', () => {
    const src = source({ '2024-02-29': 8.5, '2025-02-27': 12.75 }, {});
    const r = computeAdjustment(terms, '2025-03-01', src);
    expect(r.rent.toFixed(2)).toBe('450000.00');
    expect(r.calculation.iclCurrentDate).toBe('2025-02-27');
  });

  it('lanza IndexNotAvailableError si el índice no fue publicado', () => {
    const src = source({ '2024-03-01': 8.5 }, {});
    expect(() => computeAdjustment(terms, '2025-03-01', src)).toThrow(IndexNotAvailableError);
  });
});

describe('IPC', () => {
  // Contrato enero 2025, actualización trimestral, lag 1 → abril usa niveles dic-24 → mar-25.
  const terms: ContractTerms = {
    startDate: '2025-01-01',
    endDate: '2027-01-01',
    baseRent: '500000',
    indexType: 'IPC',
    adjustmentFrequencyMonths: 3,
    ipcLagMonths: 1,
    paymentDueDay: 5,
  };
  const ipc = { '2024-12-01': 100, '2025-01-01': 102.2, '2025-02-01': 104.67, '2025-03-01': 108.6 };

  it('aplica la variación acumulada entre el mes base y el anterior a la actualización', () => {
    const r = computeAdjustment(terms, '2025-04-01', source({}, ipc));
    expect(r.factor.toString()).toBe('1.086');
    expect(r.rent.toFixed(2)).toBe('543000.00');
    expect(r.calculation.accumulatedPct).toBe('8.6000');
  });

  it('equivale a componer variaciones mensuales', () => {
    expect(accumulateMonthlyRates([2.2, 2.4168297, 3.7546575]).mul(100).toFixed(2)).toBe('8.60');
  });

  it('genera cronograma con períodos provisionales cuando falta el índice', () => {
    const schedule = buildSchedule(terms, source({}, ipc));
    expect(schedule).toHaveLength(24);
    expect(schedule[0]).toMatchObject({ periodNumber: 1, dueDate: '2025-01-05', provisional: false });
    expect(schedule[3]!.amount.toFixed(2)).toBe('543000.00');
    expect(schedule[3]!.adjustment).toBeDefined();
    expect(schedule[6]!.provisional).toBe(true); // julio: falta IPC de junio
    expect(schedule[6]!.amount.toFixed(2)).toBe('543000.00');

    const projected = projectSchedule(schedule, terms, 2);
    // julio: 3 meses al 2% sobre el último firme
    expect(projected[6]!.projectedAmount.toFixed(2)).toBe(new Decimal(543000).mul(1.02 ** 3).toFixed(2));
  });
});

describe('punitorios y liquidación', () => {
  it('no devenga dentro de los días de gracia', () => {
    const r = computePenalty({ outstanding: 100000, dueDate: '2025-05-10', asOf: '2025-05-13', graceDays: 3, dailyPenaltyPct: 0.1 });
    expect(r.penalty.toFixed(2)).toBe('0.00');
  });

  it('devenga desde el vencimiento al superar la gracia', () => {
    const r = computePenalty({ outstanding: 100000, dueDate: '2025-05-10', asOf: '2025-05-20', graceDays: 3, dailyPenaltyPct: 0.1 });
    expect(r).toMatchObject({ daysLate: 10 });
    expect(r.penalty.toFixed(2)).toBe('1000.00');
  });

  it('liquida neto al locador', () => {
    const s = computeSettlement({ collected: 543000, penalties: 1000, commissionPct: 5 });
    expect(s.commission.toFixed(2)).toBe('27200.00');
    expect(s.netToLandlord.toFixed(2)).toBe('516800.00');
  });
});
