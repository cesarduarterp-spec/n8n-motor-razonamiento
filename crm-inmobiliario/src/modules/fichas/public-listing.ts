import { createHash } from 'node:crypto';
import type { MediaItem } from '../../database/schema.js';

/**
 * Proyección PÚBLICA de un inmueble / unidad / desarrollo. Se construye por
 * lista blanca de campos (nunca con spread de la fila): agregar una columna
 * privada a la tabla no la filtra por accidente a una ficha ni al agente IA.
 */
export type FichaVariant = 'public' | 'neutral';

export interface Branding {
  agencyName: string;
  logoUrl?: string;
  primaryColor: string;
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
}

export interface PublicListing {
  kind: 'property' | 'development';
  reference: string;
  title: string;
  operation?: string;
  propertyType?: string;
  price?: { amount: number; currency: string } | null;
  expenses?: { amount: number; currency: string } | null;
  specs: Array<[string, string]>;
  description: string;
  amenities: string[];
  tags: string[];
  photos: string[];
  videos: string[];
  tours: Array<{ provider: string; url: string }>;
  location: { label: string; address?: string; approx?: { lat: number; lng: number } };
  development?: { name: string; kind: string; status: string; deliveryDate?: string | null };
  units?: Array<{ unit: string; typology: string; m2?: string | null; status: string; price?: string | null; currency?: string }>;
  branding?: Branding;
  disclaimer: string;
}

const KIND_LABEL: Record<string, string> = {
  building: 'Edificio',
  lot_subdivision: 'Loteo',
  condominium: 'Condominio',
  gated_community: 'Barrio cerrado',
  office_park: 'Polo de oficinas',
};
const STATUS_LABEL: Record<string, string> = {
  pozo: 'En pozo',
  preventa: 'Preventa',
  en_construccion: 'En construcción',
  entrega_inmediata: 'Entrega inmediata',
  terminado: 'Terminado',
};
const OPERATION_LABEL: Record<string, string> = { sale: 'Venta', rent: 'Alquiler', temporary_rent: 'Alquiler temporario' };

export const labels = { KIND_LABEL, STATUS_LABEL, OPERATION_LABEL };

/** Redondeo a 2 decimales (~1,1 km): ubicación aproximada sin revelar la dirección. */
export function approxLocation(lat: string | null, lng: string | null): { lat: number; lng: number } | undefined {
  if (lat == null || lng == null) return undefined;
  return { lat: Math.round(Number(lat) * 100) / 100, lng: Math.round(Number(lng) * 100) / 100 };
}

/**
 * Ficha neutra: elimina teléfonos, emails, URLs y @handles del texto libre
 * (los asesores suelen escribir "consultas al 11-5555-0000" en la descripción).
 */
export function stripContactData(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[contacto oculto]')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '[enlace oculto]')
    .replace(/(?<![\w@])@[a-z0-9_.]{3,}/gi, '[contacto oculto]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => {
      const digits = m.replace(/\D/g, '');
      // Montos con separador de miles ("1.250.000") no son teléfonos.
      const isAmount = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(m.trim());
      return digits.length >= 8 && !isAmount ? '[contacto oculto]' : m;
    });
}

/** Referencia neutra estable: un colega puede citarla sin conocer el código interno ni la inmobiliaria. */
export function neutralReference(tenantId: string, entityId: string): string {
  return 'N-' + createHash('sha256').update(`${tenantId}:${entityId}`).digest('hex').slice(0, 8).toUpperCase();
}

export function splitMedia(media: MediaItem[]) {
  return {
    photos: media.filter((m) => m.type === 'photo' || m.type === 'floorplan').map((m) => m.url),
    videos: media.filter((m) => m.type === 'video').map((m) => m.url),
    tours: media.filter((m) => m.type === 'tour360').map((m) => ({ provider: m.provider ?? 'other', url: m.url })),
  };
}

export const DISCLAIMER = {
  public: 'Las medidas, superficies y valores son aproximados y no constituyen oferta vinculante. Precios sujetos a modificación sin previo aviso.',
  neutral:
    'Ficha neutra compartida entre colegas de la red. No contiene datos de contacto del corredor ni la dirección exacta del inmueble. Medidas y valores aproximados.',
};
