import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, lte, or, gte, sql } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import { env } from '../../config/env.js';
import { DatabaseService, type TenantTx } from '../../database/database.service.js';
import { developments, priceListItems, priceLists, properties, propertyUnits, tenants } from '../../database/schema.js';
import { todayIn } from '../finance/dates.js';
import {
  approxLocation,
  type Branding,
  DISCLAIMER,
  type FichaVariant,
  labels,
  neutralReference,
  type PublicListing,
  splitMedia,
  stripContactData,
} from './public-listing.js';
import { renderHtml, renderPdf } from './render.js';

export type FichaFormat = 'json' | 'html' | 'pdf';
export interface FichaTarget {
  tenantId: string;
  kind: 'property' | 'development';
  id: string;
  variant: FichaVariant;
}

const secret = () => new TextEncoder().encode(env().JWT_SECRET);
const n = (v: string | null | undefined) => (v == null ? null : Number(v));

@Injectable()
export class FichasService {
  constructor(private readonly db: DatabaseService) {}

  /** Genera la ficha y registra la exportación (EXPORT) en el audit trail. */
  async render(target: FichaTarget, format: FichaFormat, via: 'api' | 'link') {
    const listing = await this.db.withTenant(target.tenantId, async (tx) => {
      const l = target.kind === 'property' ? await this.buildProperty(tx, target) : await this.buildDevelopment(tx, target);
      await tx.execute(
        sql`select audit_event('EXPORT', ${target.kind === 'property' ? 'properties' : 'developments'}, ${target.id}, ${JSON.stringify({ variant: target.variant, format, via })}::jsonb)`,
      );
      return l;
    });
    if (format === 'json') return { contentType: 'application/json', body: listing };
    if (format === 'html') return { contentType: 'text/html; charset=utf-8', body: renderHtml(listing) };
    return { contentType: 'application/pdf', body: await renderPdf(listing) };
  }

  /** Link firmado y con vencimiento para compartir la ficha sin login (clientes o colegas). */
  async shareLink(target: FichaTarget, days = 30): Promise<{ url: string; expiresAt: string }> {
    const exp = Math.floor(Date.now() / 1000) + days * 86_400;
    const token = await new SignJWT({ tid: target.tenantId, k: target.kind, v: target.variant })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(target.id)
      .setAudience('ficha')
      .setExpirationTime(exp)
      .sign(secret());
    return { url: `${env().PUBLIC_BASE_URL}/public/fichas/${token}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async verifyLink(token: string): Promise<FichaTarget> {
    const { payload } = await jwtVerify(token, secret(), { audience: 'ficha' });
    return {
      tenantId: String(payload.tid),
      kind: payload.k === 'development' ? 'development' : 'property',
      id: String(payload.sub),
      variant: payload.v === 'neutral' ? 'neutral' : 'public',
    };
  }

  private async branding(tx: TenantTx, tenantId: string, variant: FichaVariant): Promise<Branding | undefined> {
    if (variant === 'neutral') return undefined; // marca blanca: sin logo, nombre ni contacto del broker
    const [t] = await tx.select({ name: tenants.name, settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
    const b = t?.settings.branding ?? {};
    return { agencyName: t?.name ?? '', primaryColor: b.primaryColor ?? '#1f3a5f', logoUrl: b.logoUrl, phone: b.phone, email: b.email, website: b.website, address: b.address };
  }

  private async buildProperty(tx: TenantTx, t: FichaTarget): Promise<PublicListing> {
    const [p] = await tx.select().from(properties).where(eq(properties.id, t.id));
    if (!p || p.status === 'draft') throw new NotFoundException('Propiedad inexistente o no publicada');
    const [unit] = await tx
      .select({ unit: propertyUnits, dev: developments })
      .from(propertyUnits)
      .innerJoin(developments, eq(developments.id, propertyUnits.developmentId))
      .where(eq(propertyUnits.propertyId, p.id));

    const neutral = t.variant === 'neutral';
    const media = splitMedia(p.media);
    const specs: Array<[string, string]> = [];
    if (p.rooms) specs.push(['Ambientes', String(p.rooms)]);
    if (p.bedrooms) specs.push(['Dormitorios', String(p.bedrooms)]);
    if (p.bathrooms) specs.push(['Baños', String(p.bathrooms)]);
    if (p.coveredM2) specs.push(['Sup. cubierta', `${p.coveredM2} m²`]);
    if (p.totalM2) specs.push(['Sup. total', `${p.totalM2} m²`]);
    if (unit) {
      specs.push(['Unidad', unit.unit.unitCode], ['Tipología', unit.unit.typology]);
      if (unit.unit.floor != null) specs.push(['Piso', String(unit.unit.floor)]);
      if (unit.unit.orientation) specs.push(['Orientación', unit.unit.orientation]);
    }
    const label = [p.neighborhood, p.city, p.province].filter(Boolean).join(', ');

    return {
      kind: 'property',
      reference: neutral ? neutralReference(t.tenantId, p.id) : p.code,
      title: p.title,
      operation: labels.OPERATION_LABEL[p.operation],
      propertyType: p.propertyType,
      price: p.price ? { amount: Number(p.price), currency: p.currency } : null,
      expenses: p.expenses ? { amount: Number(p.expenses), currency: 'ARS' } : null,
      specs,
      description: neutral ? stripContactData(p.description ?? '') : p.description ?? '',
      amenities: unit?.dev.amenities ?? [],
      tags: p.tags,
      ...media,
      location: {
        label: label || 'Ubicación a confirmar',
        // Dirección exacta solo en ficha pública y si el inmueble lo permite; nunca en la neutra.
        address: !neutral && p.showExactAddress && p.address ? `${p.address}${label ? `, ${label}` : ''}` : undefined,
        approx: approxLocation(p.latitude, p.longitude),
      },
      development: unit
        ? {
            name: unit.dev.name,
            kind: labels.KIND_LABEL[unit.dev.kind] ?? unit.dev.kind,
            status: labels.STATUS_LABEL[unit.dev.constructionStatus] ?? unit.dev.constructionStatus,
            deliveryDate: unit.dev.deliveryDate,
          }
        : undefined,
      branding: await this.branding(tx, t.tenantId, t.variant),
      disclaimer: neutral ? DISCLAIMER.neutral : DISCLAIMER.public,
    };
  }

  private async buildDevelopment(tx: TenantTx, t: FichaTarget): Promise<PublicListing> {
    const [d] = await tx.select().from(developments).where(eq(developments.id, t.id));
    if (!d || !d.published) throw new NotFoundException('Emprendimiento inexistente o no publicado');
    const neutral = t.variant === 'neutral';
    const today = todayIn();

    const [activeList] = await tx
      .select()
      .from(priceLists)
      .where(and(eq(priceLists.developmentId, d.id), lte(priceLists.validFrom, today), or(isNull(priceLists.validTo), gte(priceLists.validTo, today))))
      .orderBy(desc(priceLists.validFrom))
      .limit(1);

    const units = await tx
      .select({ unit: propertyUnits, p: properties, price: priceListItems.price })
      .from(propertyUnits)
      .innerJoin(properties, eq(properties.id, propertyUnits.propertyId))
      .leftJoin(
        priceListItems,
        and(eq(priceListItems.unitId, propertyUnits.id), activeList ? eq(priceListItems.priceListId, activeList.id) : sql`false`),
      )
      .where(and(eq(propertyUnits.developmentId, d.id), eq(propertyUnits.status, 'available')))
      .orderBy(propertyUnits.unitCode);

    const label = [d.neighborhood, d.city, d.province].filter(Boolean).join(', ');
    const prices = units.map((u) => n(u.price)).filter((x): x is number => x != null);
    return {
      kind: 'development',
      reference: neutral ? neutralReference(t.tenantId, d.id) : d.code,
      title: d.name,
      price: prices.length ? { amount: Math.min(...prices), currency: activeList?.currency ?? 'USD' } : null,
      specs: [
        ['Tipo', labels.KIND_LABEL[d.kind] ?? d.kind],
        ['Estado de obra', labels.STATUS_LABEL[d.constructionStatus] ?? d.constructionStatus],
        ...(d.deliveryDate ? ([['Entrega estimada', d.deliveryDate]] as Array<[string, string]>) : []),
        ['Unidades disponibles', String(units.length)],
        ...(activeList?.financingPlans.length
          ? ([['Financiación', activeList.financingPlans.map((f) => `${f.name}: ${f.downPaymentPct}% + ${f.installments} cuotas`).join(' | ')]] as Array<[string, string]>)
          : []),
      ],
      description: neutral ? stripContactData(d.description ?? '') : d.description ?? '',
      amenities: d.amenities,
      tags: [],
      ...splitMedia(d.media),
      location: {
        label: label || 'Ubicación a confirmar',
        address: !neutral && d.showExactAddress && d.address ? `${d.address}${label ? `, ${label}` : ''}` : undefined,
        approx: approxLocation(d.latitude, d.longitude),
      },
      units: units.map((u) => ({
        unit: u.unit.unitCode,
        typology: u.unit.typology,
        m2: u.p.totalM2 ?? u.p.coveredM2,
        status: 'Disponible',
        price: u.price,
        currency: activeList?.currency ?? 'USD',
      })),
      branding: await this.branding(tx, t.tenantId, t.variant),
      disclaimer: neutral ? DISCLAIMER.neutral : DISCLAIMER.public,
    };
  }
}
