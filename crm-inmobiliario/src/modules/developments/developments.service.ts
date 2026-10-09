import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseService, type TenantTx } from '../../database/database.service.js';
import {
  developments,
  listingPrivateData,
  priceListItems,
  priceLists,
  properties,
  propertyUnits,
} from '../../database/schema.js';
import { todayIn } from '../finance/dates.js';
import { GeminiFrontline } from '../agents/gemini-frontline.service.js';
import { embeddingText } from '../properties/properties.service.js';

export type NewDevelopment = Omit<typeof developments.$inferInsert, 'tenantId' | 'id' | 'version' | 'deletedAt' | 'deletedBy'>;

export interface NewUnit {
  unitCode: string;
  typology: string;
  propertyType: string;
  floor?: number;
  orientation?: string;
  rooms?: number;
  bedrooms?: number;
  bathrooms?: number;
  coveredM2?: number;
  totalM2?: number;
  price?: number;
  currency?: 'ARS' | 'USD';
  operation?: 'sale' | 'rent';
}

export type PrivateData = Omit<
  typeof listingPrivateData.$inferInsert,
  'tenantId' | 'id' | 'propertyId' | 'developmentId' | 'version' | 'deletedAt' | 'deletedBy'
>;

@Injectable()
export class DevelopmentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly gemini: GeminiFrontline,
  ) {}

  create(tenantId: string, input: NewDevelopment) {
    return this.db.withTenant(tenantId, (tx) => tx.insert(developments).values({ ...input, tenantId }).returning());
  }

  /** Desarrollo + unidades (capa pública) + lista de precios vigente. */
  get(tenantId: string, id: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [dev] = await tx.select().from(developments).where(eq(developments.id, id));
      if (!dev) throw new NotFoundException();
      const units = await tx
        .select({ unit: propertyUnits, property: { id: properties.id, code: properties.code, price: properties.price, currency: properties.currency, totalM2: properties.totalM2, bedrooms: properties.bedrooms } })
        .from(propertyUnits)
        .innerJoin(properties, eq(properties.id, propertyUnits.propertyId))
        .where(eq(propertyUnits.developmentId, id))
        .orderBy(propertyUnits.unitCode);
      const lists = await tx.select().from(priceLists).where(eq(priceLists.developmentId, id)).orderBy(sql`${priceLists.validFrom} desc`);
      return { development: dev, units, priceLists: lists };
    });
  }

  list(tenantId: string) {
    return this.db.withTenant(tenantId, (tx) => tx.select().from(developments).orderBy(developments.name));
  }

  /**
   * Alta de unidad: crea la fila en `properties` (heredando zona, multimedia
   * y amenities del desarrollo, con su embedding) y la vincula en `property_units`.
   */
  async addUnit(tenantId: string, developmentId: string, u: NewUnit) {
    const dev = await this.db.withTenant(tenantId, async (tx) => {
      const [d] = await tx.select().from(developments).where(eq(developments.id, developmentId));
      if (!d) throw new NotFoundException('Emprendimiento inexistente');
      return d;
    });
    const property = {
      code: `${dev.code}-${u.unitCode}`.replace(/\s+/g, ''),
      title: `${dev.name} – ${u.typology} (${u.unitCode})`,
      description: dev.description,
      operation: u.operation ?? ('sale' as const),
      status: 'available' as const,
      propertyType: u.propertyType,
      neighborhood: dev.neighborhood,
      city: dev.city,
      province: dev.province,
      address: dev.address,
      showExactAddress: dev.showExactAddress,
      latitude: dev.latitude,
      longitude: dev.longitude,
      price: u.price?.toFixed(2),
      currency: u.currency ?? 'USD',
      rooms: u.rooms,
      bedrooms: u.bedrooms,
      bathrooms: u.bathrooms,
      coveredM2: u.coveredM2?.toFixed(2),
      totalM2: u.totalM2?.toFixed(2),
      tags: [...dev.amenities, dev.constructionStatus],
      media: dev.media,
      developmentId,
    };
    const embedding = await this.gemini.embed(tenantId, embeddingText(property), 'RETRIEVAL_DOCUMENT');

    return this.db.withTenant(tenantId, async (tx) => {
      const [p] = await tx.insert(properties).values({ ...property, tenantId, embedding, embeddingUpdatedAt: new Date() }).returning({ id: properties.id, code: properties.code });
      const [unit] = await tx
        .insert(propertyUnits)
        .values({ tenantId, developmentId, propertyId: p!.id, unitCode: u.unitCode, typology: u.typology, floor: u.floor, orientation: u.orientation })
        .returning();
      return { unit, property: p };
    });
  }

  /** Cambio de estado de unidad; se refleja en el inmueble para que deje de ofrecerse/matchearse. */
  setUnitStatus(tenantId: string, unitId: string, status: 'available' | 'reserved' | 'sold' | 'blocked') {
    return this.db.withTenant(tenantId, async (tx) => {
      const [unit] = await tx.update(propertyUnits).set({ status }).where(eq(propertyUnits.id, unitId)).returning();
      if (!unit) throw new NotFoundException();
      const propertyStatus = status === 'available' ? 'available' : status === 'sold' ? 'sold' : status === 'reserved' ? 'reserved' : 'paused';
      await tx.update(properties).set({ status: propertyStatus }).where(eq(properties.id, unit.propertyId));
      return unit;
    });
  }

  /**
   * Publica una lista de precios. Si ya está vigente, actualiza el precio de
   * cada unidad en `properties` (cada cambio queda en el audit trail con old/new).
   */
  publishPriceList(
    tenantId: string,
    developmentId: string,
    input: { name: string; currency: 'ARS' | 'USD'; validFrom: string; validTo?: string; adjustmentRule?: string; financingPlans?: Array<{ name: string; downPaymentPct: number; installments: number; notes?: string }>; items: Array<{ unitId: string; price: number }> },
  ) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [list] = await tx
        .insert(priceLists)
        .values({
          tenantId,
          developmentId,
          name: input.name,
          currency: input.currency,
          validFrom: input.validFrom,
          validTo: input.validTo,
          adjustmentRule: input.adjustmentRule,
          financingPlans: input.financingPlans ?? [],
        })
        .returning();
      const units = await tx
        .select()
        .from(propertyUnits)
        .where(and(eq(propertyUnits.developmentId, developmentId), inArray(propertyUnits.id, input.items.map((i) => i.unitId))));
      const byId = new Map(units.map((u) => [u.id, u]));
      for (const item of input.items) {
        const unit = byId.get(item.unitId);
        if (!unit) throw new NotFoundException(`Unidad ${item.unitId} no pertenece al emprendimiento`);
        await tx.insert(priceListItems).values({ tenantId, priceListId: list!.id, unitId: unit.id, price: item.price.toFixed(2) });
        if (input.validFrom <= todayIn()) {
          await tx.update(properties).set({ price: item.price.toFixed(2), currency: input.currency }).where(eq(properties.id, unit.propertyId));
        }
      }
      return { priceList: list, items: input.items.length };
    });
  }

  // ───────────── Capa privada (RBAC + RLS restrictiva + PRIVATE_ACCESS auditado) ─────────────

  getPrivate(tenantId: string, target: { propertyId?: string; developmentId?: string }) {
    return this.db.withTenant(tenantId, async (tx) => {
      const row = await this.privateRow(tx, target);
      await tx.execute(
        sql`select audit_event('PRIVATE_ACCESS', ${target.propertyId ? 'properties' : 'developments'}, ${target.propertyId ?? target.developmentId ?? null}, ${JSON.stringify({ found: Boolean(row) })}::jsonb)`,
      );
      return row ?? null;
    });
  }

  upsertPrivate(tenantId: string, target: { propertyId?: string; developmentId?: string }, data: PrivateData) {
    return this.db.withTenant(tenantId, async (tx) => {
      const existing = await this.privateRow(tx, target);
      if (existing) {
        const [row] = await tx.update(listingPrivateData).set(data).where(eq(listingPrivateData.id, existing.id)).returning();
        return row;
      }
      const [row] = await tx.insert(listingPrivateData).values({ ...data, ...target, tenantId }).returning();
      return row;
    });
  }

  private async privateRow(tx: TenantTx, target: { propertyId?: string; developmentId?: string }) {
    const [row] = await tx
      .select()
      .from(listingPrivateData)
      .where(target.propertyId ? eq(listingPrivateData.propertyId, target.propertyId) : eq(listingPrivateData.developmentId, target.developmentId ?? ''));
    return row;
  }
}
