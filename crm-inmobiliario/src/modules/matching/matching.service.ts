import { Injectable, NotFoundException } from '@nestjs/common';
import { and, cosineDistance, eq, isNotNull, sql } from 'drizzle-orm';
import { DatabaseService, type TenantTx } from '../../database/database.service.js';
import { leadRequirements, leads, pipelineStages, properties, propertyMatches } from '../../database/schema.js';
import { GeminiFrontline } from '../agents/gemini-frontline.service.js';
import { type Requirements, requirementsText, scoreMatch } from './scoring.js';

export interface RequirementsInput {
  operation?: 'sale' | 'rent' | 'temporary_rent' | null;
  propertyTypes?: string[];
  neighborhoods?: string[];
  minPrice?: number | null;
  maxPrice?: number | null;
  currency?: 'ARS' | 'USD' | null;
  minBedrooms?: number | null;
  mustHaves?: string[];
  naturalLanguage?: string;
}

const CANDIDATES = 50;
const KEEP_TOP = 10;
const MIN_SCORE = 0.45;

const num = (v: string | null) => (v == null ? null : Number(v));

/**
 * Smart Semantic Matching: requerimientos del lead (lenguaje natural +
 * filtros) vectorizados con Gemini embeddings y cruzados con la cartera en
 * pgvector. Funciona en ambos sentidos: lead → propiedades y propiedad →
 * leads (cuando entra un inmueble nuevo). Solo usa la capa pública.
 */
@Injectable()
export class MatchingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly gemini: GeminiFrontline,
  ) {}

  /** Fusiona requerimientos nuevos con los existentes y re-vectoriza. */
  async upsertRequirements(tenantId: string, leadId: string, input: RequirementsInput) {
    const current = await this.db.withTenant(tenantId, async (tx) => {
      const [lead] = await tx.select({ id: leads.id }).from(leads).where(eq(leads.id, leadId));
      if (!lead) throw new NotFoundException('Lead inexistente');
      const [r] = await tx.select().from(leadRequirements).where(eq(leadRequirements.leadId, leadId));
      return r;
    });

    const merged = {
      operation: input.operation ?? current?.operation ?? null,
      propertyTypes: unique([...(current?.propertyTypes ?? []), ...(input.propertyTypes ?? [])]),
      neighborhoods: unique([...(current?.neighborhoods ?? []), ...(input.neighborhoods ?? [])]),
      minPrice: input.minPrice ?? num(current?.minPrice ?? null),
      maxPrice: input.maxPrice ?? num(current?.maxPrice ?? null),
      currency: input.currency ?? (current?.currency as 'ARS' | 'USD' | null) ?? null,
      minBedrooms: input.minBedrooms ?? current?.minBedrooms ?? null,
      mustHaves: unique([...(current?.mustHaves ?? []), ...(input.mustHaves ?? [])]),
      naturalLanguage: [current?.naturalLanguage, input.naturalLanguage].filter(Boolean).join(' ').slice(-2000),
    };
    // Embedding fuera de la transacción (I/O de red).
    const embedding = await this.gemini.embed(tenantId, requirementsText(merged), 'RETRIEVAL_QUERY');

    const values = {
      tenantId,
      leadId,
      operation: merged.operation,
      propertyTypes: merged.propertyTypes,
      neighborhoods: merged.neighborhoods,
      minPrice: merged.minPrice?.toFixed(2) ?? null,
      maxPrice: merged.maxPrice?.toFixed(2) ?? null,
      currency: merged.currency,
      minBedrooms: merged.minBedrooms,
      mustHaves: merged.mustHaves,
      naturalLanguage: merged.naturalLanguage,
      embedding,
      embeddingUpdatedAt: new Date(),
    };
    return this.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .insert(leadRequirements)
        .values(values)
        .onConflictDoUpdate({ target: leadRequirements.leadId, set: { ...values, tenantId: undefined, leadId: undefined } })
        .returning({ id: leadRequirements.id });
      return row;
    });
  }

  /** Lead → propiedades. Persiste el top en property_matches (respetando descartes previos). */
  async matchForLead(tenantId: string, leadId: string, limit = KEEP_TOP) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [req] = await tx.select().from(leadRequirements).where(eq(leadRequirements.leadId, leadId));
      if (!req?.embedding) return [];

      const distance = cosineDistance(properties.embedding, req.embedding);
      await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
      const rows = await tx
        .select({
          id: properties.id,
          code: properties.code,
          title: properties.title,
          operation: properties.operation,
          propertyType: properties.propertyType,
          neighborhood: properties.neighborhood,
          price: properties.price,
          currency: properties.currency,
          bedrooms: properties.bedrooms,
          distance,
        })
        .from(properties)
        .where(
          and(
            eq(properties.status, 'available'),
            isNotNull(properties.embedding),
            req.operation ? eq(properties.operation, req.operation) : undefined,
          ),
        )
        .orderBy(distance)
        .limit(CANDIDATES);

      const scored = rows
        .map((p) => ({ p, ...scoreMatch(toReq(req), { ...p, price: num(p.price) }, 1 - Number(p.distance)), semantic: 1 - Number(p.distance) }))
        .filter((m) => m.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      await this.persist(tx, tenantId, scored.map((m) => ({ leadId, propertyId: m.p.id, score: m.score, semantic: m.semantic, reasons: m.reasons })));
      return scored.map((m) => ({
        propertyId: m.p.id,
        code: m.p.code,
        title: m.p.title,
        price: m.p.price,
        currency: m.p.currency,
        neighborhood: m.p.neighborhood,
        score: m.score,
        reasons: m.reasons,
      }));
    });
  }

  /** Propiedad → leads abiertos con requerimientos afines (para avisar a los asesores). */
  async matchForProperty(tenantId: string, propertyId: string, limit = 25) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [p] = await tx.select().from(properties).where(eq(properties.id, propertyId));
      if (!p?.embedding) return [];

      const distance = cosineDistance(leadRequirements.embedding, p.embedding);
      const rows = await tx
        .select({ req: leadRequirements, distance })
        .from(leadRequirements)
        .innerJoin(leads, eq(leads.id, leadRequirements.leadId))
        .innerJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
        .where(
          and(
            isNotNull(leadRequirements.embedding),
            eq(pipelineStages.isWon, false),
            eq(pipelineStages.isLost, false),
            sql`(${leadRequirements.operation} is null or ${leadRequirements.operation} = ${p.operation})`,
          ),
        )
        .orderBy(distance)
        .limit(CANDIDATES);

      const facts = { ...p, price: num(p.price) };
      const scored = rows
        .map((r) => ({ leadId: r.req.leadId, semantic: 1 - Number(r.distance), ...scoreMatch(toReq(r.req), facts, 1 - Number(r.distance)) }))
        .filter((m) => m.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      await this.persist(tx, tenantId, scored.map((m) => ({ leadId: m.leadId, propertyId, score: m.score, semantic: m.semantic, reasons: m.reasons })));
      return scored;
    });
  }

  listForLead(tenantId: string, leadId: string) {
    return this.db.withTenant(tenantId, (tx) =>
      tx
        .select({ match: propertyMatches, title: properties.title, code: properties.code, price: properties.price, currency: properties.currency })
        .from(propertyMatches)
        .innerJoin(properties, eq(properties.id, propertyMatches.propertyId))
        .where(eq(propertyMatches.leadId, leadId))
        .orderBy(sql`${propertyMatches.score} desc`),
    );
  }

  setStatus(tenantId: string, matchId: string, status: 'sent' | 'dismissed' | 'converted') {
    return this.db.withTenant(tenantId, (tx) =>
      tx.update(propertyMatches).set({ status }).where(eq(propertyMatches.id, matchId)).returning(),
    );
  }

  private async persist(
    tx: TenantTx,
    tenantId: string,
    matches: Array<{ leadId: string; propertyId: string; score: number; semantic: number; reasons: string[] }>,
  ) {
    for (const m of matches) {
      await tx
        .insert(propertyMatches)
        .values({
          tenantId,
          leadId: m.leadId,
          propertyId: m.propertyId,
          score: m.score.toFixed(4),
          semanticScore: m.semantic.toFixed(4),
          reasons: m.reasons,
        })
        .onConflictDoUpdate({
          target: [propertyMatches.leadId, propertyMatches.propertyId],
          // El score se refresca, pero un match descartado por el asesor no vuelve a "suggested".
          set: { score: sql`excluded.score`, semanticScore: sql`excluded.semantic_score`, reasons: sql`excluded.reasons` },
        });
    }
  }
}

function toReq(r: typeof leadRequirements.$inferSelect): Requirements {
  return {
    operation: r.operation,
    propertyTypes: r.propertyTypes,
    neighborhoods: r.neighborhoods,
    minPrice: num(r.minPrice),
    maxPrice: num(r.maxPrice),
    currency: r.currency,
    minBedrooms: r.minBedrooms,
  };
}

function unique(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
