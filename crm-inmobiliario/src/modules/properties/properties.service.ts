import { Injectable } from '@nestjs/common';
import { and, cosineDistance, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { properties } from '../../database/schema.js';
import { GeminiFrontline } from '../agents/gemini-frontline.service.js';

export interface PropertySearch {
  query?: string;
  operation?: 'sale' | 'rent' | 'temporary_rent' | null;
  neighborhood?: string | null;
  maxPrice?: number | null;
  currency?: 'ARS' | 'USD' | null;
  minBedrooms?: number | null;
  limit?: number;
}

export type NewProperty = Omit<typeof properties.$inferInsert, 'tenantId' | 'id' | 'embedding' | 'embeddingUpdatedAt'>;

/** Texto canónico que se embebe: lo que un interesado describiría al buscar. */
function embeddingText(p: NewProperty): string {
  return [
    p.title,
    `${p.operation === 'sale' ? 'Venta' : 'Alquiler'} de ${p.propertyType}`,
    [p.neighborhood, p.city, p.province].filter(Boolean).join(', '),
    p.bedrooms != null ? `${p.bedrooms} dormitorios` : '',
    p.coveredM2 ? `${p.coveredM2} m² cubiertos` : '',
    p.tags?.join(', '),
    p.description,
  ]
    .filter(Boolean)
    .join('. ');
}

@Injectable()
export class PropertiesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly gemini: GeminiFrontline,
  ) {}

  async create(tenantId: string, input: NewProperty) {
    const embedding = await this.gemini.embed(tenantId, embeddingText(input), 'RETRIEVAL_DOCUMENT');
    const [row] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .insert(properties)
        .values({ ...input, tenantId, embedding, embeddingUpdatedAt: new Date() })
        .returning({ id: properties.id, code: properties.code }),
    );
    return row;
  }

  /**
   * Búsqueda híbrida: filtros estructurados (SQL) + ranking semántico
   * (distancia coseno pgvector). RLS garantiza que solo se vea el catálogo del tenant.
   */
  async search(tenantId: string, s: PropertySearch) {
    const queryEmbedding = s.query ? await this.gemini.embed(tenantId, s.query, 'RETRIEVAL_QUERY') : undefined;
    const filters = [
      eq(properties.status, 'available'),
      s.operation ? eq(properties.operation, s.operation) : undefined,
      s.neighborhood ? ilike(properties.neighborhood, `%${s.neighborhood}%`) : undefined,
      s.maxPrice ? lte(properties.price, String(s.maxPrice)) : undefined,
      s.currency ? eq(properties.currency, s.currency) : undefined,
      s.minBedrooms ? gte(properties.bedrooms, s.minBedrooms) : undefined,
    ].filter((f) => f !== undefined);

    const distance = queryEmbedding ? cosineDistance(properties.embedding, queryEmbedding) : sql<number>`0`;
    return this.db.withTenant(tenantId, async (tx) => {
      // pgvector >= 0.8: escaneo iterativo para que el HNSW no pierda resultados al combinar con filtros.
      // (requiere la imagen pgvector/pgvector con versión >= 0.8; ver docker-compose).
      if (queryEmbedding) await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
      return tx
        .select({
          id: properties.id,
          code: properties.code,
          title: properties.title,
          operation: properties.operation,
          price: properties.price,
          currency: properties.currency,
          neighborhood: properties.neighborhood,
          bedrooms: properties.bedrooms,
          coveredM2: properties.coveredM2,
          url: sql<string | null>`${properties.metadata}->>'url'`,
          distance,
        })
        .from(properties)
        .where(and(...filters))
        .orderBy(distance)
        .limit(Math.min(s.limit ?? 5, 20));
    });
  }
}
