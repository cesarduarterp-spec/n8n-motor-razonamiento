/**
 * Cálculo de turnos de visita (puro, testeable).
 *
 * El horario de atención se define por día de semana en hora local del
 * tenant con un offset fijo (Argentina no usa horario de verano: -03:00).
 *   hours = { "1": [["09:00","13:00"],["14:00","18:00"]], ..., "6": [["10:00","13:00"]] }
 *   (0 = domingo … 6 = sábado)
 */
export interface Interval {
  start: Date;
  end: Date;
}

export interface SlotConfig {
  hours: Record<string, [string, string][]>;
  utcOffset: string; // "-03:00"
  durationMin: number;
  bufferMin: number;
  minLeadMinutes: number; // anticipación mínima para reservar
}

export const DEFAULT_SLOT_CONFIG: SlotConfig = {
  hours: {
    '1': [['09:00', '13:00'], ['14:00', '18:00']],
    '2': [['09:00', '13:00'], ['14:00', '18:00']],
    '3': [['09:00', '13:00'], ['14:00', '18:00']],
    '4': [['09:00', '13:00'], ['14:00', '18:00']],
    '5': [['09:00', '13:00'], ['14:00', '18:00']],
    '6': [['10:00', '13:00']],
  },
  utcOffset: '-03:00',
  durationMin: 45,
  bufferMin: 15,
  minLeadMinutes: 120,
};

function offsetMinutes(offset: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`Offset inválido: ${offset}`);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Fecha local (YYYY-MM-DD) + hora local (HH:MM) → instante UTC. */
export function localToUtc(day: string, hhmm: string, offset: string): Date {
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - offsetMinutes(offset) * 60_000);
}

/** Día local (YYYY-MM-DD) y día de semana de un instante. */
export function localDay(at: Date, offset: string): { day: string; weekday: number } {
  const local = new Date(at.getTime() + offsetMinutes(offset) * 60_000);
  return { day: local.toISOString().slice(0, 10), weekday: local.getUTCDay() };
}

/** Formato legible en español para el mensaje al contacto: "jueves 16/10 10:30". */
export function formatSlot(at: Date, offset: string): string {
  const local = new Date(at.getTime() + offsetMinutes(offset) * 60_000);
  const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const dd = String(local.getUTCDate()).padStart(2, '0');
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mi = String(local.getUTCMinutes()).padStart(2, '0');
  return `${days[local.getUTCDay()]} ${dd}/${mm} ${hh}:${mi}`;
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/**
 * Turnos libres entre `from` y `from + days`, descontando los ocupados
 * (calendario + visitas ya agendadas) con su margen de traslado.
 */
export function freeSlots(params: { from: Date; days: number; busy: Interval[]; config: SlotConfig; now?: Date }): Date[] {
  const { config } = params;
  const now = params.now ?? new Date();
  const earliest = new Date(now.getTime() + config.minLeadMinutes * 60_000);
  const step = (config.durationMin + config.bufferMin) * 60_000;
  const busy = params.busy.map((b) => ({
    start: new Date(b.start.getTime() - config.bufferMin * 60_000),
    end: new Date(b.end.getTime() + config.bufferMin * 60_000),
  }));

  const out: Date[] = [];
  const startDay = localDay(params.from, config.utcOffset).day;
  for (let i = 0; i < params.days; i++) {
    const day = new Date(Date.parse(`${startDay}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    for (const [open, close] of config.hours[String(weekday)] ?? []) {
      const windowEnd = localToUtc(day, close, config.utcOffset);
      for (let t = localToUtc(day, open, config.utcOffset).getTime(); t + config.durationMin * 60_000 <= windowEnd.getTime(); t += step) {
        const slot = { start: new Date(t), end: new Date(t + config.durationMin * 60_000) };
        if (slot.start < earliest || slot.start < params.from) continue;
        if (busy.some((b) => overlaps(slot, b))) continue;
        out.push(slot.start);
      }
    }
  }
  return out;
}

/** Elige hasta `n` opciones repartidas en distintos días/franjas (mejor UX en WhatsApp que 30 horarios seguidos). */
export function spreadPick(slots: Date[], n: number, offset: string): Date[] {
  const byDay = new Map<string, Date[]>();
  for (const s of slots) {
    const d = localDay(s, offset).day;
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const picked: Date[] = [];
  for (let round = 0; picked.length < n; round++) {
    let added = false;
    for (const daySlots of byDay.values()) {
      // ronda 0: primer turno del día; ronda 1: uno de la tarde; luego el resto.
      const idx = round === 0 ? 0 : round === 1 ? Math.floor(daySlots.length / 2) : round;
      const s = daySlots[idx];
      if (s && !picked.includes(s) && picked.length < n) {
        picked.push(s);
        added = true;
      }
    }
    if (!added) break;
  }
  return picked.sort((a, b) => a.getTime() - b.getTime());
}
