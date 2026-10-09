/**
 * Selección equitativa de asesor (funciones puras, testeables).
 *
 * Round-robin "justo": no rota a ciegas, sino que elige al asesor del pool
 * con MENOS leads abiertos; empata por quien recibió su última asignación
 * hace más tiempo (o nunca), y por último por id para que sea determinístico.
 * Así un asesor que vuelve de vacaciones no recibe una avalancha, y uno con
 * cartera saturada deja de recibir hasta equilibrarse.
 */
export interface Candidate {
  userId: string;
  openLeads: number;
  lastAssignedAt: Date | null;
}

export function pickAssignee(candidates: Candidate[]): string | undefined {
  return [...candidates].sort(
    (a, b) =>
      a.openLeads - b.openLeads ||
      (a.lastAssignedAt?.getTime() ?? 0) - (b.lastAssignedAt?.getTime() ?? 0) ||
      a.userId.localeCompare(b.userId),
  )[0]?.userId;
}

export interface RuleCriteria {
  neighborhoods?: string[];
  propertyTypes?: string[];
  operations?: string[];
  channels?: string[];
}

export interface LeadFacts {
  neighborhoods: string[];
  propertyTypes: string[];
  operation?: string | null;
  channel?: string | null;
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();

/** Un criterio vacío es comodín; uno con valores exige al menos una coincidencia. */
export function ruleMatches(criteria: RuleCriteria, lead: LeadFacts): boolean {
  const anyOf = (wanted: string[] | undefined, have: string[]) =>
    !wanted?.length || have.some((h) => wanted.some((w) => norm(h).includes(norm(w)) || norm(w).includes(norm(h))));
  return (
    anyOf(criteria.neighborhoods, lead.neighborhoods) &&
    anyOf(criteria.propertyTypes, lead.propertyTypes) &&
    anyOf(criteria.operations, lead.operation ? [lead.operation] : []) &&
    anyOf(criteria.channels, lead.channel ? [lead.channel] : [])
  );
}
