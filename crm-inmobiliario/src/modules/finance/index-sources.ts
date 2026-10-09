import { Decimal } from 'decimal.js';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { env } from '../../config/env.js';
import type { Db, TenantTx } from '../../database/database.service.js';
import { indexRates } from '../../database/schema.js';
import { addDays, addMonths, firstOfMonth, type IsoDate } from './dates.js';
import type { IndexSource } from './rent-calculator.js';

export interface IndexPoint {
  date: IsoDate;
  value: string;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

/**
 * ICL diario — API de Estadísticas del BCRA (variable 40 = ICL).
 * Tolera los dos formatos conocidos de respuesta:
 *   v2: { results: [{ fecha, valor }] }
 *   v3: { results: [{ idVariable, detalle: [{ fecha, valor }] }] }
 */
export async function fetchIclFromBcra(from: IsoDate, to: IsoDate): Promise<IndexPoint[]> {
  const { BCRA_API_BASE, BCRA_ICL_VARIABLE_ID } = env();
  const url = `${BCRA_API_BASE}/${BCRA_ICL_VARIABLE_ID}?desde=${from}&hasta=${to}&limit=3000`;
  const body = (await fetchJson(url)) as { results?: Array<Record<string, unknown>> };
  const rows = (body.results ?? []).flatMap((r) =>
    Array.isArray(r.detalle) ? (r.detalle as Array<Record<string, unknown>>) : [r],
  );
  return rows
    .filter((r) => typeof r.fecha === 'string' && r.valor !== undefined && r.valor !== null)
    .map((r) => ({ date: String(r.fecha).slice(0, 10), value: new Decimal(r.valor as number).toString() }));
}

/** IPC mensual (nivel general nacional, base dic-2016=100) — API de Series de Tiempo de datos.gob.ar (fuente INDEC). */
export async function fetchIpcFromIndec(): Promise<IndexPoint[]> {
  const body = (await fetchJson(env().INDEC_IPC_SERIES_URL)) as { data?: Array<[string, number | null]> };
  return (body.data ?? [])
    .filter(([, v]) => v !== null)
    .map(([d, v]) => ({ date: firstOfMonth(d.slice(0, 10)), value: new Decimal(v as number).toString() }));
}

/**
 * IndexSource en memoria para un contrato: precarga de la BD el rango de
 * ICL/IPC necesario (una sola query por índice) y lo sirve sincrónicamente al
 * calculador puro.
 */
export async function loadIndexSource(db: Db | TenantTx, from: IsoDate, to: IsoDate): Promise<IndexSource> {
  const rows = await db
    .select({ indexType: indexRates.indexType, date: indexRates.date, value: indexRates.value })
    .from(indexRates)
    .where(and(gte(indexRates.date, addMonths(addDays(from, -10), -3)), lte(indexRates.date, to)));
  const map = new Map<string, Decimal>();
  for (const r of rows) map.set(`${r.indexType}:${r.date}`, new Decimal(r.value));
  return { get: (index, date) => map.get(`${index}:${date}`) };
}

export async function latestIndexDate(db: Db, index: 'ICL' | 'IPC'): Promise<IsoDate | undefined> {
  const [row] = await db
    .select({ date: indexRates.date })
    .from(indexRates)
    .where(eq(indexRates.indexType, index))
    .orderBy(desc(indexRates.date))
    .limit(1);
  return row?.date;
}
