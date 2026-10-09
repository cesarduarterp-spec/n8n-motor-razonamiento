/**
 * Score híbrido del smart matching (puro, testeable):
 *   score = 0.6 × similitud semántica (coseno) + 0.4 × ajuste estructurado
 * El ajuste estructurado promedia solo los criterios que el lead declaró
 * (presupuesto, dormitorios, zona, tipo). Si no declaró ninguno, manda la
 * similitud semántica. Devuelve además los motivos legibles para el asesor.
 */
export interface Requirements {
  operation?: string | null;
  propertyTypes: string[];
  neighborhoods: string[];
  minPrice?: number | null;
  maxPrice?: number | null;
  currency?: string | null;
  minBedrooms?: number | null;
}

export interface ListingFacts {
  operation: string;
  propertyType: string;
  neighborhood: string | null;
  price: number | null;
  currency: string;
  bedrooms: number | null;
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

export const SEMANTIC_WEIGHT = 0.6;

export function scoreMatch(req: Requirements, p: ListingFacts, semantic: number): { score: number; reasons: string[] } {
  const parts: number[] = [];
  const reasons: string[] = [];

  if (req.maxPrice != null || req.minPrice != null) {
    if (p.price == null || (req.currency && req.currency !== p.currency)) {
      parts.push(0);
      reasons.push('Precio no comparable (moneda distinta o sin precio)');
    } else if (req.maxPrice != null && p.price > req.maxPrice) {
      const over = (p.price - req.maxPrice) / req.maxPrice;
      // Hasta 10 % arriba del presupuesto aún suma (margen de negociación).
      parts.push(over <= 0.1 ? 0.5 : 0);
      reasons.push(over <= 0.1 ? `Hasta ${Math.round(over * 100)}% sobre el presupuesto` : 'Fuera de presupuesto');
    } else if (req.minPrice != null && p.price < req.minPrice) {
      parts.push(0.5);
      reasons.push('Por debajo del rango buscado');
    } else {
      parts.push(1);
      reasons.push('Dentro del presupuesto');
    }
  }

  if (req.minBedrooms != null) {
    const ok = (p.bedrooms ?? 0) >= req.minBedrooms;
    parts.push(ok ? 1 : 0);
    reasons.push(ok ? `${p.bedrooms} dormitorios (pide ${req.minBedrooms}+)` : `Solo ${p.bedrooms ?? 0} dormitorios`);
  }

  if (req.neighborhoods.length) {
    const ok = p.neighborhood != null && req.neighborhoods.some((n) => norm(p.neighborhood!).includes(norm(n)));
    parts.push(ok ? 1 : 0);
    if (ok) reasons.push(`Zona buscada: ${p.neighborhood}`);
  }

  if (req.propertyTypes.length) {
    const ok = req.propertyTypes.some((t) => norm(p.propertyType).includes(norm(t)) || norm(t).includes(norm(p.propertyType)));
    parts.push(ok ? 1 : 0);
    if (ok) reasons.push(`Tipo: ${p.propertyType}`);
  }

  const sem = Math.max(0, Math.min(1, semantic));
  if (sem >= 0.75) reasons.unshift('Alta afinidad con lo que describió');
  const structured = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : sem;
  const score = SEMANTIC_WEIGHT * sem + (1 - SEMANTIC_WEIGHT) * structured;
  return { score: Math.round(score * 10_000) / 10_000, reasons };
}

/** Texto canónico de requerimientos que se vectoriza (RETRIEVAL_QUERY). */
export function requirementsText(r: Requirements & { mustHaves: string[]; naturalLanguage: string }): string {
  const op = r.operation === 'sale' ? 'Comprar' : r.operation === 'temporary_rent' ? 'Alquiler temporario de' : 'Alquilar';
  return [
    `${op} ${r.propertyTypes.join(' o ') || 'inmueble'}`,
    r.neighborhoods.length ? `en ${r.neighborhoods.join(', ')}` : '',
    r.minBedrooms ? `con al menos ${r.minBedrooms} dormitorios` : '',
    r.maxPrice ? `hasta ${r.currency ?? ''} ${r.maxPrice}` : '',
    r.mustHaves.length ? `Indispensable: ${r.mustHaves.join(', ')}` : '',
    r.naturalLanguage,
  ]
    .filter(Boolean)
    .join('. ');
}
