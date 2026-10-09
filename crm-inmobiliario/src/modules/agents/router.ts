import { type Classification, SPECIALIST_INTENTS } from './agent.schemas.js';

export type Route = { engine: 'gemini' } | { engine: 'claude'; reason: string } | { engine: 'human'; reason: string };

/**
 * Red de seguridad determinística: aunque el clasificador se equivoque, estas
 * expresiones siempre escalan al especialista (asimetría de costos: un
 * reclamo legal mal atendido cuesta mucho más que una llamada extra a Claude).
 */
const LEGAL_PATTERNS =
  /carta\s+documento|abogad|desalojo|intimaci[oó]n|intimar|demanda|mediaci[oó]n|rescind|rescisi[oó]n|juicio|denuncia|defensa del consumidor|dep[oó]sito en garant[ií]a|no (voy a|puedo) pagar|me (atras|retras)/i;

export function route(c: Classification, text: string, opts: { isTenantOrLandlord: boolean }): Route {
  if (c.intent === 'human_handoff') return { engine: 'human', reason: 'El contacto pidió hablar con una persona' };
  if (SPECIALIST_INTENTS.has(c.intent)) return { engine: 'claude', reason: `intent=${c.intent}` };
  if (LEGAL_PATTERNS.test(text)) return { engine: 'claude', reason: 'patrón legal detectado' };
  if (c.sentiment === 'hostile') return { engine: 'claude', reason: 'sentimiento hostil' };
  if (opts.isTenantOrLandlord && c.legalRiskSignals.length > 0) {
    return { engine: 'claude', reason: `señales: ${c.legalRiskSignals.join('; ')}` };
  }
  if (c.confidence < 0.5 && opts.isTenantOrLandlord && c.intent === 'other') {
    return { engine: 'claude', reason: 'baja confianza con cliente con contrato' };
  }
  return { engine: 'gemini' };
}
