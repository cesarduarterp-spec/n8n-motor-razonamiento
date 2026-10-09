import { describe, expect, it } from 'vitest';
import { buildIcs, parseBusy } from './ical.js';

const from = new Date('2026-10-12T00:00:00Z');
const to = new Date('2026-10-26T00:00:00Z');

describe('iCal', () => {
  it('genera un feed válido que se puede volver a leer (ida y vuelta)', () => {
    const ics = buildIcs('Visitas – Ana', [
      {
        uid: 'visit-1@crm',
        start: new Date('2026-10-13T13:00:00Z'),
        end: new Date('2026-10-13T13:45:00Z'),
        summary: 'Visita TORRE-N-3B – Carla, Pérez; 2 amb',
        description: 'Línea 1\nLínea 2',
        location: 'Av. Santa Fe 4000, Palermo',
      },
    ]);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('SUMMARY:Visita TORRE-N-3B – Carla\\, Pérez\\; 2 amb');
    expect(ics).toContain('DESCRIPTION:Línea 1\\nLínea 2');
    expect(ics.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75)).toBe(true);
    expect(parseBusy(ics, from, to)).toEqual([{ start: new Date('2026-10-13T13:00:00Z'), end: new Date('2026-10-13T13:45:00Z') }]);
  });

  it('expande eventos repetitivos, respeta EXDATE e ignora "Disponible" y cancelados', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:gym@x',
      'DTSTAMP:20261001T000000Z',
      'DTSTART;TZID=America/Argentina/Buenos_Aires:20261005T090000',
      'DTEND;TZID=America/Argentina/Buenos_Aires:20261005T100000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'EXDATE;TZID=America/Argentina/Buenos_Aires:20261019T090000',
      'SUMMARY:Gimnasio',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:cumple@x',
      'DTSTAMP:20261001T000000Z',
      'DTSTART;VALUE=DATE:20261014',
      'DTEND;VALUE=DATE:20261015',
      'TRANSP:TRANSPARENT',
      'SUMMARY:Cumpleaños',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:cancel@x',
      'DTSTAMP:20261001T000000Z',
      'DTSTART:20261015T150000Z',
      'DTEND:20261015T160000Z',
      'STATUS:CANCELLED',
      'SUMMARY:Reunión cancelada',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const busy = parseBusy(ics, from, to).map((b) => b.start.toISOString());
    // Lunes 12/10 09:00 AR (12:00 UTC); el 19/10 está excluido por EXDATE.
    expect(busy).toEqual(['2026-10-12T12:00:00.000Z']);
  });
});
