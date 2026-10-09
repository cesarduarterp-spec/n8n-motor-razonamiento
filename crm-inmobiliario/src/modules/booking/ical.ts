import ical from 'node-ical';
import type { Interval } from './slots.js';

/**
 * iCalendar (RFC 5545): formato estándar y gratuito que entienden Google
 * Calendar, Apple Calendar y Outlook. Reemplaza la integración OAuth con
 * Google: el CRM PUBLICA las visitas como feed .ics y, opcionalmente, LEE la
 * "dirección secreta en formato iCal" del calendario personal del asesor
 * para saber cuándo está ocupado.
 */

export interface IcsEvent {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  location?: string;
  status?: 'CONFIRMED' | 'CANCELLED';
  sequence?: number; // versión del evento: los clientes actualizan cuando sube
  updatedAt?: Date;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Escapado de texto según RFC 5545 §3.3.11. */
const text = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Líneas de máx. 75 octetos con continuación (RFC 5545 §3.1). */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--; // no cortar un carácter UTF-8
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.join('\r\n ');
}

export function buildIcs(calendarName: string, events: IcsEvent[], now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CRM Inmobiliario//Agenda de visitas//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(calendarName)}`,
    'X-WR-TIMEZONE:America/Argentina/Buenos_Aires',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(e.start)}`,
      `DTEND:${stamp(e.end)}`,
      `SUMMARY:${text(e.summary)}`,
      ...(e.description ? [`DESCRIPTION:${text(e.description)}`] : []),
      ...(e.location ? [`LOCATION:${text(e.location)}`] : []),
      `STATUS:${e.status ?? 'CONFIRMED'}`,
      `SEQUENCE:${e.sequence ?? 0}`,
      ...(e.updatedAt ? [`LAST-MODIFIED:${stamp(e.updatedAt)}`] : []),
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Visita en 1 hora',
      'TRIGGER:-PT1H',
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/**
 * Intervalos ocupados de un calendario externo entre `from` y `to`.
 * Expande eventos repetitivos (RRULE, EXDATE, excepciones), ignora los
 * cancelados y los marcados como "Disponible" (TRANSPARENT: en Google, por
 * ejemplo, los cumpleaños o eventos de día completo informativos).
 */
export function parseBusy(icsText: string, from: Date, to: Date): Interval[] {
  const data = ical.parseICS(icsText);
  const busy: Interval[] = [];
  for (const item of Object.values(data)) {
    if (!item || item.type !== 'VEVENT') continue;
    const ev = item;
    if (ev.status === 'CANCELLED' || ev.transparency === 'TRANSPARENT') continue;

    if (ev.rrule) {
      for (const inst of ical.expandRecurringEvent(ev, { from, to, expandOngoing: true })) {
        busy.push({ start: new Date(inst.start), end: new Date(inst.end) });
      }
      continue;
    }
    const start = new Date(ev.start);
    const end = ev.end ? new Date(ev.end) : new Date(start.getTime() + (ev.datetype === 'date' ? 86_400_000 : 3_600_000));
    if (start < to && end > from) busy.push({ start, end });
  }
  return busy.sort((a, b) => a.start.getTime() - b.start.getTime());
}
