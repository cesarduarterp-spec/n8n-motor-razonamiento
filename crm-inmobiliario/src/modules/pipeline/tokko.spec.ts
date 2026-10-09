import { describe, expect, it } from 'vitest';
import { formatSlot, freeSlots, localToUtc, spreadPick, DEFAULT_SLOT_CONFIG } from '../booking/slots.js';
import { approxLocation, neutralReference, stripContactData } from '../fichas/public-listing.js';
import { renderHtml } from '../fichas/render.js';
import { scoreMatch } from '../matching/scoring.js';
import { pickAssignee, ruleMatches } from './assignment.js';

describe('round-robin equitativo', () => {
  it('elige al asesor con menos leads abiertos', () => {
    expect(
      pickAssignee([
        { userId: 'a', openLeads: 5, lastAssignedAt: new Date('2026-10-01') },
        { userId: 'b', openLeads: 2, lastAssignedAt: new Date('2026-10-09') },
      ]),
    ).toBe('b');
  });

  it('a igual carga, rota al que hace más que no recibe (o nunca recibió)', () => {
    expect(
      pickAssignee([
        { userId: 'a', openLeads: 3, lastAssignedAt: new Date('2026-10-09T10:00Z') },
        { userId: 'b', openLeads: 3, lastAssignedAt: null },
        { userId: 'c', openLeads: 3, lastAssignedAt: new Date('2026-10-01') },
      ]),
    ).toBe('b');
  });

  it('reglas por zona/tipo ignoran tildes y mayúsculas; criterio vacío = comodín', () => {
    const lead = { neighborhoods: ['Núñez'], propertyTypes: ['departamento'], operation: 'rent', channel: 'whatsapp' };
    expect(ruleMatches({ neighborhoods: ['nunez', 'Belgrano'] }, lead)).toBe(true);
    expect(ruleMatches({ neighborhoods: ['Palermo'] }, lead)).toBe(false);
    expect(ruleMatches({ operations: ['sale'] }, lead)).toBe(false);
    expect(ruleMatches({}, lead)).toBe(true);
  });
});

describe('smart matching', () => {
  const req = { operation: 'rent', propertyTypes: ['departamento'], neighborhoods: ['Palermo'], maxPrice: 600000, currency: 'ARS', minBedrooms: 1 };
  const base = { operation: 'rent', propertyType: 'departamento', neighborhood: 'Palermo Soho', price: 550000, currency: 'ARS', bedrooms: 1 };

  it('combina similitud semántica y ajuste estructurado', () => {
    const m = scoreMatch(req, base, 0.8);
    expect(m.score).toBeCloseTo(0.6 * 0.8 + 0.4 * 1, 4);
    expect(m.reasons).toContain('Dentro del presupuesto');
  });

  it('tolera hasta 10% sobre presupuesto a medio puntaje y castiga lo que excede', () => {
    expect(scoreMatch(req, { ...base, price: 640000 }, 0.8).score).toBeGreaterThan(scoreMatch(req, { ...base, price: 900000 }, 0.8).score);
  });

  it('sin criterios estructurados manda la similitud semántica', () => {
    expect(scoreMatch({ propertyTypes: [], neighborhoods: [] }, base, 0.7).score).toBeCloseTo(0.7, 4);
  });
});

describe('booker: turnos', () => {
  const cfg = { ...DEFAULT_SLOT_CONFIG, minLeadMinutes: 0 };

  it('convierte hora local AR (-03:00) a UTC', () => {
    expect(localToUtc('2026-10-12', '09:00', '-03:00').toISOString()).toBe('2026-10-12T12:00:00.000Z');
  });

  it('genera turnos dentro del horario y excluye los ocupados con margen', () => {
    const from = new Date('2026-10-12T11:00:00Z'); // lunes 08:00 AR
    const busy = [{ start: new Date('2026-10-12T13:00:00Z'), end: new Date('2026-10-12T14:00:00Z') }]; // 10:00-11:00 AR
    const slots = freeSlots({ from, days: 1, busy, config: cfg, now: from });
    const labels = slots.map((s) => formatSlot(s, '-03:00'));
    expect(labels[0]).toBe('lunes 12/10 09:00');
    expect(labels).not.toContain('lunes 12/10 10:00'); // ocupado
    expect(labels).not.toContain('lunes 12/10 11:00'); // dentro del buffer de 15'
    expect(labels.at(-1)).toBe('lunes 12/10 17:00');
  });

  it('no ofrece domingos y reparte opciones en distintos días', () => {
    const from = new Date('2026-10-17T11:00:00Z'); // sábado
    const slots = freeSlots({ from, days: 3, busy: [], config: cfg, now: from });
    expect(slots.some((s) => formatSlot(s, '-03:00').startsWith('domingo'))).toBe(false);
    const picked = spreadPick(slots, 4, '-03:00').map((s) => formatSlot(s, '-03:00').split(' ')[0]);
    expect(new Set(picked).size).toBeGreaterThan(1);
  });
});

describe('fichas', () => {
  it('ficha neutra quita teléfonos, mails, links y @ pero conserva precios', () => {
    const out = stripContactData('Excelente depto. USD 1.250.000. Consultas al 11 5555-0000 o ventas@inmo.com, www.inmo.com, @inmo.ok');
    expect(out).toContain('USD 1.250.000');
    expect(out).not.toMatch(/5555|ventas@|www\.|@inmo\.ok/);
  });

  it('referencia neutra estable y ubicación aproximada', () => {
    expect(neutralReference('t1', 'p1')).toBe(neutralReference('t1', 'p1'));
    expect(neutralReference('t1', 'p1')).not.toBe(neutralReference('t2', 'p1'));
    expect(approxLocation('-34.588123', '-58.430987')).toEqual({ lat: -34.59, lng: -58.43 });
  });

  it('el HTML escapa contenido y descarta URLs no https', () => {
    const html = renderHtml({
      kind: 'property',
      reference: 'N-1',
      title: '<script>alert(1)</script>',
      specs: [],
      description: '',
      amenities: [],
      tags: [],
      photos: ['javascript:alert(1)', 'https://cdn.example.com/a.jpg'],
      videos: [],
      tours: [],
      location: { label: 'Palermo' },
      disclaimer: 'x',
    });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('https://cdn.example.com/a.jpg');
  });
});
