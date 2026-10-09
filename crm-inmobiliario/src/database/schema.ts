import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/*
 * Convenciones:
 * - Toda tabla transaccional lleva `tenant_id` (FK a tenants) y tiene RLS
 *   forzada (ver migración 0001_rls.sql). La única tabla global es
 *   `index_rates` (ICL/IPC son datos públicos compartidos).
 * - Montos en numeric(14,2) (string en TS → se operan con decimal.js).
 * - Índices numeric(20,8) para no perder precisión en el cociente ICL.
 */

export interface MediaItem {
  type: 'photo' | 'video' | 'tour360' | 'floorplan';
  url: string;
  provider?: 'youtube' | 'matterport' | 'kuula' | 'other';
  caption?: string;
}

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};
const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
/**
 * Soft delete + versionado optimista. Un trigger convierte todo DELETE en
 * `deleted_at = now()` e incrementa `version` en cada UPDATE (0003_audit.sql).
 */
const lifecycle = {
  version: integer('version').notNull().default(1),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'), // 'user:<uuid>' | 'agent:<nombre>' | 'system:<proceso>'
};

// ───────────────────────────── Enums ─────────────────────────────

export const userRole = pgEnum('user_role', ['admin', 'broker', 'sales_agent', 'back_office']);
export const operationType = pgEnum('operation_type', ['sale', 'rent', 'temporary_rent']);
export const propertyStatus = pgEnum('property_status', ['draft', 'available', 'reserved', 'rented', 'sold', 'paused']);
export const channel = pgEnum('channel', ['whatsapp', 'instagram', 'messenger', 'tiktok', 'youtube', 'web', 'email']);
export const contactKind = pgEnum('contact_kind', ['prospect', 'tenant', 'landlord', 'guarantor', 'buyer', 'seller']);
export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound']);
export const messageAuthor = pgEnum('message_author', ['contact', 'agent_gemini', 'agent_claude', 'human']);
export const indexType = pgEnum('index_type', ['ICL', 'IPC', 'FIXED', 'CASA_PROPIA']);
export const contractStatus = pgEnum('contract_status', ['draft', 'needs_review', 'active', 'finished', 'terminated']);
export const partyRole = pgEnum('party_role', ['landlord', 'tenant', 'guarantor']);
export const installmentStatus = pgEnum('installment_status', ['pending', 'under_review', 'paid', 'partial', 'overdue', 'cancelled']);
export const documentStatus = pgEnum('document_status', ['uploaded', 'processing', 'extracted', 'failed']);
export const draftStatus = pgEnum('draft_status', ['pending_approval', 'approved', 'sent', 'rejected']);
export const developmentKind = pgEnum('development_kind', ['building', 'lot_subdivision', 'condominium', 'gated_community', 'office_park']);
export const constructionStatus = pgEnum('construction_status', ['pozo', 'preventa', 'en_construccion', 'entrega_inmediata', 'terminado']);
export const unitStatus = pgEnum('unit_status', ['available', 'reserved', 'sold', 'blocked']);
export const auditAction = pgEnum('audit_action', [
  'CREATE',
  'UPDATE',
  'DELETE',
  'RESTORE',
  'PAYMENT_EXEC',
  'AI_INTERACTION',
  'PRIVATE_ACCESS',
  'EXPORT',
]);
export const actorType = pgEnum('actor_type', ['user', 'agent', 'system', 'public']);
export const visitStatus = pgEnum('visit_status', ['scheduled', 'cancelled', 'done', 'no_show']);
export const matchStatus = pgEnum('match_status', ['suggested', 'sent', 'dismissed', 'converted']);

// ───────────────────────────── Tenancy & RBAC ─────────────────────────────

export const tenants = pgTable('tenants', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  cuit: text('cuit'),
  // Matrícula del martillero/corredor responsable (CUCICBA, CMCPSI, etc.).
  brokerLicense: text('broker_license'),
  plan: text('plan').notNull().default('starter'),
  settings: jsonb('settings')
    .$type<{
      agencyCommissionPct?: number;
      defaultGraceDays?: number;
      defaultDailyPenaltyPct?: number;
      timezone?: string;
      useOwnLlmKeys?: boolean;
      /** Branding para fichas públicas. */
      branding?: { logoUrl?: string; primaryColor?: string; phone?: string; email?: string; website?: string; address?: string };
      /** Agenda de visitas (Argentina no tiene horario de verano: offset fijo). */
      visits?: { durationMin?: number; bufferMin?: number; utcOffset?: string; hours?: Record<string, [string, string][]> };
    }>()
    .notNull()
    .default({}),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});

/** Secretos por tenant (tokens de WhatsApp, páginas Meta, LLM propios), cifrados AES-256-GCM. */
export const tenantSecrets = pgTable(
  'tenant_secrets',
  {
    id: id(),
    tenantId: tenantId(),
    // p.ej. 'anthropic_api_key', 'gemini_api_key', 'whatsapp_access_token', 'meta_page_token'
    name: text('name').notNull(),
    ciphertext: text('ciphertext').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('tenant_secrets_name_uq').on(t.tenantId, t.name)],
);

export const users = pgTable(
  'users',
  {
    id: id(),
    tenantId: tenantId(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull(),
    active: boolean('active').notNull().default(true),
    // Google Calendar del asesor (refresh token en tenant_secrets: google_refresh_token:<userId>).
    calendarId: text('calendar_id'),
    // Zonas / tipos que atiende (para reglas de asignación).
    zones: text('zones').array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_email_uq').on(t.tenantId, t.email)],
);

/**
 * Cuentas de canal conectadas: mapean el identificador externo de la
 * plataforma (phone_number_id, page_id, ig_user_id, open_id, channel_id) al
 * tenant. Es la única tabla que se consulta sin contexto de tenant (rol
 * SYSTEM) para enrutar los webhooks entrantes.
 */
export const channelAccounts = pgTable(
  'channel_accounts',
  {
    id: id(),
    tenantId: tenantId(),
    channel: channel('channel').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    displayName: text('display_name'),
    // nombre del secreto en tenant_secrets que contiene el token de envío
    accessTokenSecret: text('access_token_secret'),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('channel_accounts_external_uq').on(t.channel, t.externalAccountId)],
);

// ───────────────────────────── Propiedades ─────────────────────────────

export const properties = pgTable(
  'properties',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    operation: operationType('operation').notNull(),
    status: propertyStatus('status').notNull().default('draft'),
    propertyType: text('property_type').notNull(), // depto, casa, ph, local, lote...
    address: text('address'),
    neighborhood: text('neighborhood'),
    city: text('city'),
    province: text('province'),
    price: money('price'),
    currency: char('currency', { length: 3 }).notNull().default('ARS'),
    expenses: money('expenses'),
    rooms: smallint('rooms'),
    bedrooms: smallint('bedrooms'),
    bathrooms: smallint('bathrooms'),
    coveredM2: numeric('covered_m2', { precision: 8, scale: 2 }),
    totalM2: numeric('total_m2', { precision: 8, scale: 2 }),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    developmentId: uuid('development_id').references(() => developments.id),
    // Ubicación exacta: dato restringido. La capa pública solo expone coordenadas redondeadas (~1 km).
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    showExactAddress: boolean('show_exact_address').notNull().default(false),
    // Fotos HD, video y recorridos 360°: [{ type: 'photo'|'video'|'tour360', url, provider?, caption? }]
    media: jsonb('media').$type<MediaItem[]>().notNull().default([]),
    // Embedding semántico (título + descripción + atributos). Dimensión = EMBEDDING_DIMENSIONS.
    embedding: vector('embedding', { dimensions: 768 }),
    embeddingUpdatedAt: timestamp('embedding_updated_at', { withTimezone: true }),
    ...lifecycle,
    ...timestamps,
  },
  (t) => [
    uniqueIndex('properties_code_uq').on(t.tenantId, t.code).where(sql`deleted_at is null`),
    index('properties_search_idx').on(t.tenantId, t.operation, t.status),
    index('properties_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

// ───────────────────────────── Contactos, leads, omnicanal ─────────────────────────────

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    tenantId: tenantId(),
    fullName: text('full_name'),
    kinds: contactKind('kinds').array().notNull().default(sql`'{prospect}'::contact_kind[]`),
    phoneE164: text('phone_e164'),
    email: text('email'),
    documentId: text('document_id'), // DNI / CUIT
    notes: text('notes'),
    ...lifecycle,
    ...timestamps,
  },
  (t) => [
    index('contacts_phone_idx').on(t.tenantId, t.phoneE164),
    index('contacts_document_idx').on(t.tenantId, t.documentId),
  ],
);

/** Identidades por canal → historial omnicanal unificado en un único contacto. */
export const contactIdentities = pgTable(
  'contact_identities',
  {
    id: id(),
    tenantId: tenantId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    channel: channel('channel').notNull(),
    externalId: text('external_id').notNull(), // wa_id, PSID, IGSID, open_id, YT channel id
    handle: text('handle'),
    ...timestamps,
  },
  (t) => [uniqueIndex('contact_identities_uq').on(t.tenantId, t.channel, t.externalId)],
);

export const leads = pgTable(
  'leads',
  {
    id: id(),
    tenantId: tenantId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id').references(() => properties.id),
    assignedUserId: uuid('assigned_user_id').references(() => users.id),
    // Etapa del Kanban configurable. Si llega null, un trigger asigna la primera etapa del tenant.
    stageId: uuid('stage_id')
      .notNull()
      .references(() => pipelineStages.id),
    stageChangedAt: timestamp('stage_changed_at', { withTimezone: true }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    sourceChannel: channel('source_channel'),
    sourceCampaign: text('source_campaign'),
    score: smallint('score'),
    requirements: jsonb('requirements').$type<Record<string, unknown>>().notNull().default({}),
    ...lifecycle,
    ...timestamps,
  },
  (t) => [index('leads_stage_idx').on(t.tenantId, t.stageId)],
);

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    tenantId: tenantId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    channel: channel('channel').notNull(),
    channelAccountId: uuid('channel_account_id').references(() => channelAccounts.id),
    // Si un humano tomó la conversación los agentes dejan de responder.
    humanTakeover: boolean('human_takeover').notNull().default(false),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('conversations_uq').on(t.tenantId, t.contactId, t.channel)],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    direction: messageDirection('direction').notNull(),
    author: messageAuthor('author').notNull(),
    // ID de la plataforma (wamid, mid, comment id): idempotencia ante reintentos.
    externalId: text('external_id'),
    kind: text('kind').notNull(), // text | audio | image | document | comment | ...
    body: text('body'),
    mediaPath: text('media_path'),
    mediaMime: text('media_mime'),
    // Transcripción/OCR/extracción producida por Gemini.
    enrichment: jsonb('enrichment').$type<Record<string, unknown>>(),
    intent: text('intent'),
    ...lifecycle,
    ...timestamps,
  },
  (t) => [
    uniqueIndex('messages_external_uq').on(t.tenantId, t.externalId),
    index('messages_conv_idx').on(t.conversationId, t.createdAt),
  ],
);

/** Memoria persistente por contacto (resumen rodante + hechos estructurados). */
export const conversationMemory = pgTable(
  'conversation_memory',
  {
    tenantId: tenantId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull().default(''),
    facts: jsonb('facts').$type<Record<string, unknown>>().notNull().default({}),
    messagesSinceSummary: integer('messages_since_summary').notNull().default(0),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.contactId] })],
);

/** Borradores de Claude (avisos de mora, respuestas a reclamos) que requieren aprobación humana. */
export const agentDrafts = pgTable('agent_drafts', {
  id: id(),
  tenantId: tenantId(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
  contractId: uuid('contract_id').references(() => contracts.id),
  kind: text('kind').notNull(), // reply | late_payment_notice | renegotiation_proposal | formal_notice
  status: draftStatus('status').notNull().default('pending_approval'),
  content: text('content').notNull(),
  rationale: text('rationale'),
  riskLevel: text('risk_level'),
  approvedBy: uuid('approved_by').references(() => users.id),
  ...timestamps,
});

// ───────────────────────────── Contratos y finanzas ─────────────────────────────

export const contracts = pgTable(
  'contracts',
  {
    id: id(),
    tenantId: tenantId(),
    propertyId: uuid('property_id').references(() => properties.id),
    status: contractStatus('status').notNull().default('draft'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    baseRent: money('base_rent').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('ARS'),
    indexType: indexType('index_type').notNull(),
    adjustmentFrequencyMonths: smallint('adjustment_frequency_months').notNull(),
    // Meses de rezago del IPC (INDEC publica a mediados del mes siguiente).
    ipcLagMonths: smallint('ipc_lag_months').notNull().default(1),
    paymentDueDay: smallint('payment_due_day').notNull().default(10),
    graceDays: smallint('grace_days').notNull().default(0),
    // Interés punitorio diario en % (ej. 0.1 = 0,1% diario).
    dailyPenaltyPct: numeric('daily_penalty_pct', { precision: 6, scale: 4 }).notNull().default('0'),
    depositAmount: money('deposit_amount'),
    agencyCommissionPct: numeric('agency_commission_pct', { precision: 5, scale: 2 }),
    clauses: jsonb('clauses').$type<Record<string, unknown>>().notNull().default({}),
    sourceDocumentId: uuid('source_document_id'),
    ...lifecycle,
    ...timestamps,
  },
  (t) => [index('contracts_status_idx').on(t.tenantId, t.status)],
);

export const contractParties = pgTable(
  'contract_parties',
  {
    id: id(),
    tenantId: tenantId(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contracts.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    role: partyRole('role').notNull(),
  },
  (t) => [uniqueIndex('contract_parties_uq').on(t.contractId, t.contactId, t.role)],
);

export const contractDocuments = pgTable('contract_documents', {
  id: id(),
  tenantId: tenantId(),
  contractId: uuid('contract_id').references(() => contracts.id),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  storagePath: text('storage_path').notNull(),
  mimeType: text('mime_type').notNull(),
  sha256: text('sha256').notNull(),
  status: documentStatus('status').notNull().default('uploaded'),
  extraction: jsonb('extraction').$type<Record<string, unknown>>(),
  warnings: jsonb('warnings').$type<string[]>(),
  error: text('error'),
  ...timestamps,
});

/** Histórico global de índices (sin tenant_id): ICL diario BCRA, IPC mensual INDEC. */
export const indexRates = pgTable(
  'index_rates',
  {
    indexType: indexType('index_type').notNull(),
    // ICL: fecha del día. IPC: primer día del mes al que corresponde el nivel.
    date: date('date').notNull(),
    value: numeric('value', { precision: 20, scale: 8 }).notNull(),
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.indexType, t.date] })],
);

/** Cada actualización aplicada a un contrato, con el detalle del cálculo (auditable). */
export const contractAdjustments = pgTable(
  'contract_adjustments',
  {
    id: id(),
    tenantId: tenantId(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contracts.id, { onDelete: 'cascade' }),
    effectiveDate: date('effective_date').notNull(),
    previousRent: money('previous_rent').notNull(),
    newRent: money('new_rent').notNull(),
    factor: numeric('factor', { precision: 20, scale: 10 }).notNull(),
    calculation: jsonb('calculation').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('contract_adjustments_uq').on(t.contractId, t.effectiveDate)],
);

export const paymentSchedules = pgTable(
  'payment_schedules',
  {
    id: id(),
    tenantId: tenantId(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contracts.id, { onDelete: 'cascade' }),
    periodNumber: smallint('period_number').notNull(),
    periodMonth: date('period_month').notNull(), // primer día del mes del período
    dueDate: date('due_date').notNull(),
    amount: money('amount').notNull(),
    // true mientras el monto dependa de un índice aún no publicado.
    provisional: boolean('provisional').notNull().default(false),
    status: installmentStatus('status').notNull().default('pending'),
    paidAmount: money('paid_amount').notNull().default('0'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    penaltyAmount: money('penalty_amount').notNull().default('0'),
    ...lifecycle,
    ...timestamps,
  },
  (t) => [
    uniqueIndex('payment_schedules_period_uq').on(t.contractId, t.periodNumber),
    index('payment_schedules_due_idx').on(t.tenantId, t.status, t.dueDate),
  ],
);

/** Comprobantes de pago (transferencias, depósitos) — muchos llegan por WhatsApp como imagen. */
export const paymentReceipts = pgTable('payment_receipts', {
  id: id(),
  tenantId: tenantId(),
  scheduleId: uuid('schedule_id').references(() => paymentSchedules.id),
  contactId: uuid('contact_id').references(() => contacts.id),
  messageId: uuid('message_id').references(() => messages.id),
  amount: money('amount'),
  paidOn: date('paid_on'),
  operationNumber: text('operation_number'),
  payerName: text('payer_name'),
  bank: text('bank'),
  mediaPath: text('media_path'),
  extraction: jsonb('extraction').$type<Record<string, unknown>>(),
  verified: boolean('verified').notNull().default(false),
  verifiedBy: uuid('verified_by').references(() => users.id),
  ...lifecycle,
  ...timestamps,
});

/** Liquidación mensual al locador (cobrado − comisión − gastos = neto a transferir). */
export const settlements = pgTable(
  'settlements',
  {
    id: id(),
    tenantId: tenantId(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contracts.id, { onDelete: 'cascade' }),
    periodMonth: date('period_month').notNull(),
    collected: money('collected').notNull(),
    penalties: money('penalties').notNull(),
    commission: money('commission').notNull(),
    otherDeductions: money('other_deductions').notNull().default('0'),
    netToLandlord: money('net_to_landlord').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [uniqueIndex('settlements_period_uq').on(t.contractId, t.periodMonth)],
);

// ───────────────────────────── Emprendimientos e inventario multinivel ─────────────────────────────

/** Desarrollo (edificio, loteo, condominio, barrio cerrado). Solo datos de la CAPA PÚBLICA. */
export const developments = pgTable(
  'developments',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: developmentKind('kind').notNull(),
    constructionStatus: constructionStatus('construction_status').notNull(),
    deliveryDate: date('delivery_date'),
    // Memoria descriptiva, amenities y multimedia (públicos).
    description: text('description'),
    amenities: text('amenities').array().notNull().default(sql`'{}'::text[]`),
    media: jsonb('media').$type<MediaItem[]>().notNull().default([]),
    neighborhood: text('neighborhood'),
    city: text('city'),
    province: text('province'),
    address: text('address'), // restringido: solo se publica si show_exact_address
    showExactAddress: boolean('show_exact_address').notNull().default(false),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    published: boolean('published').notNull().default(false),
    ...lifecycle,
    ...timestamps,
  },
  (t) => [uniqueIndex('developments_code_uq').on(t.tenantId, t.code).where(sql`deleted_at is null`)],
);

/**
 * Unidad de un desarrollo (depto, lote, cochera, tipología). Cada unidad
 * comercializable es también una fila de `properties` (1:1), así búsqueda,
 * matching, fichas y agente reutilizan el mismo modelo.
 */
export const propertyUnits = pgTable(
  'property_units',
  {
    id: id(),
    tenantId: tenantId(),
    developmentId: uuid('development_id')
      .notNull()
      .references(() => developments.id),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    unitCode: text('unit_code').notNull(), // ej. "3B", "Lote 45"
    typology: text('typology').notNull(), // ej. "2 ambientes", "Lote 300 m²"
    floor: smallint('floor'),
    orientation: text('orientation'),
    status: unitStatus('status').notNull().default('available'),
    ...lifecycle,
    ...timestamps,
  },
  (t) => [
    uniqueIndex('property_units_code_uq').on(t.developmentId, t.unitCode).where(sql`deleted_at is null`),
    uniqueIndex('property_units_property_uq').on(t.propertyId),
  ],
);

/** Lista de precios dinámica de un desarrollo (vigencia + planes de financiación). */
export const priceLists = pgTable('price_lists', {
  id: id(),
  tenantId: tenantId(),
  developmentId: uuid('development_id')
    .notNull()
    .references(() => developments.id),
  name: text('name').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  // Ajuste pactado (ej. índice CAC mensual) y planes de pago: anticipo %, cuotas, etc.
  adjustmentRule: text('adjustment_rule'),
  financingPlans: jsonb('financing_plans').$type<Array<{ name: string; downPaymentPct: number; installments: number; notes?: string }>>().notNull().default([]),
  ...lifecycle,
  ...timestamps,
});

export const priceListItems = pgTable(
  'price_list_items',
  {
    id: id(),
    tenantId: tenantId(),
    priceListId: uuid('price_list_id')
      .notNull()
      .references(() => priceLists.id),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => propertyUnits.id),
    price: money('price').notNull(),
  },
  (t) => [uniqueIndex('price_list_items_uq').on(t.priceListId, t.unitId)],
);

/**
 * CAPA PRIVADA de un inmueble o desarrollo. Tabla separada con una política
 * RLS adicional (restrictiva) que exige `app.can_view_private = on`, que solo
 * se setea para usuarios admin/broker. El agente IA, las fichas públicas y
 * los workers de matching nunca pueden leerla, aunque el código lo intente.
 */
export const listingPrivateData = pgTable(
  'listing_private_data',
  {
    id: id(),
    tenantId: tenantId(),
    propertyId: uuid('property_id').references(() => properties.id),
    developmentId: uuid('development_id').references(() => developments.id),
    ownerContactId: uuid('owner_contact_id').references(() => contacts.id),
    commissionPct: numeric('commission_pct', { precision: 5, scale: 2 }),
    commissionNotes: text('commission_notes'),
    exclusive: boolean('exclusive').notNull().default(false),
    exclusiveUntil: date('exclusive_until'),
    keysLocation: text('keys_location'),
    keysHolder: text('keys_holder'),
    internalNotes: text('internal_notes'),
    originAppraisal: money('origin_appraisal'),
    originAppraisalCurrency: char('origin_appraisal_currency', { length: 3 }),
    originAppraisalDate: date('origin_appraisal_date'),
    appraiser: text('appraiser'),
    ...lifecycle,
    ...timestamps,
  },
  (t) => [
    uniqueIndex('listing_private_property_uq').on(t.propertyId),
    uniqueIndex('listing_private_development_uq').on(t.developmentId),
  ],
);

// ───────────────────────────── Pipeline comercial ─────────────────────────────

/** Etapas del Kanban, configurables por tenant (se siembran por defecto al crear el tenant). */
export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: id(),
    tenantId: tenantId(),
    key: text('key').notNull(), // new, qualified, visit_scheduled, appraisal, negotiation, reservation, closed_won, closed_lost
    name: text('name').notNull(),
    position: smallint('position').notNull(),
    isWon: boolean('is_won').notNull().default(false),
    isLost: boolean('is_lost').notNull().default(false),
    slaHours: integer('sla_hours'),
    ...timestamps,
  },
  (t) => [uniqueIndex('pipeline_stages_key_uq').on(t.tenantId, t.key)],
);

/** Reglas de asignación automática (round-robin equitativo, filtrable por zona/tipo/operación/canal). */
export const assignmentRules = pgTable('assignment_rules', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  priority: smallint('priority').notNull().default(100), // menor = se evalúa primero
  criteria: jsonb('criteria')
    .$type<{ neighborhoods?: string[]; propertyTypes?: string[]; operations?: string[]; channels?: string[] }>()
    .notNull()
    .default({}),
  userIds: uuid('user_ids').array().notNull(),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});

export const assignmentState = pgTable(
  'assignment_state',
  {
    tenantId: tenantId(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => assignmentRules.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    assignedCount: integer('assigned_count').notNull().default(0),
    lastAssignedAt: timestamp('last_assigned_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.userId] })],
);

/** Requerimientos de búsqueda del lead, estructurados + vectorizados para el smart matching. */
export const leadRequirements = pgTable(
  'lead_requirements',
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    operation: operationType('operation'),
    propertyTypes: text('property_types').array().notNull().default(sql`'{}'::text[]`),
    neighborhoods: text('neighborhoods').array().notNull().default(sql`'{}'::text[]`),
    minPrice: money('min_price'),
    maxPrice: money('max_price'),
    currency: char('currency', { length: 3 }),
    minBedrooms: smallint('min_bedrooms'),
    mustHaves: text('must_haves').array().notNull().default(sql`'{}'::text[]`),
    naturalLanguage: text('natural_language').notNull().default(''),
    embedding: vector('embedding', { dimensions: 768 }),
    embeddingUpdatedAt: timestamp('embedding_updated_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('lead_requirements_lead_uq').on(t.leadId),
    index('lead_requirements_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export const propertyMatches = pgTable(
  'property_matches',
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    score: numeric('score', { precision: 5, scale: 4 }).notNull(),
    semanticScore: numeric('semantic_score', { precision: 5, scale: 4 }).notNull(),
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    status: matchStatus('status').notNull().default('suggested'),
    ...timestamps,
  },
  (t) => [uniqueIndex('property_matches_uq').on(t.leadId, t.propertyId)],
);

/** Visitas agendadas. Una restricción EXCLUDE (btree_gist) impide doble reserva del mismo asesor. */
export const visits = pgTable(
  'visits',
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    status: visitStatus('status').notNull().default('scheduled'),
    calendarEventId: text('calendar_event_id'),
    bookedBy: text('booked_by').notNull(), // 'agent:booker' | 'user:<uuid>'
    notes: text('notes'),
    ...lifecycle,
    ...timestamps,
  },
  (t) => [index('visits_user_idx').on(t.userId, t.startsAt)],
);

// ───────────────────────────── Auditoría y trazabilidad (append-only) ─────────────────────────────

/**
 * Audit trail inmutable. Lo escriben triggers de base de datos (no el código
 * de aplicación), de modo que ninguna mutación —API, workers, SQL manual—
 * queda sin registrar. Encadenado por hash por tenant (tamper-evident).
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(), // sin FK: el log sobrevive al tenant
    seq: integer('seq').notNull(),
    action: auditAction('action').notNull(),
    entityName: text('entity_name').notNull(),
    entityId: text('entity_id'),
    actorType: actorType('actor_type').notNull(),
    userId: uuid('user_id'),
    agentId: text('agent_id'),
    oldState: jsonb('old_state'),
    newState: jsonb('new_state'),
    changedFields: text('changed_fields').array(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    uniqueIndex('audit_logs_seq_uq').on(t.tenantId, t.seq),
    index('audit_logs_entity_idx').on(t.tenantId, t.entityName, t.entityId, t.occurredAt),
  ],
);

/** Cabeza de la cadena de hashes por tenant (solo la usa el trigger; sin acceso para la app). */
export const auditChainHeads = pgTable('audit_chain_heads', {
  tenantId: uuid('tenant_id').primaryKey(),
  seq: integer('seq').notNull().default(0),
  lastHash: text('last_hash').notNull().default('GENESIS'),
});

/**
 * Log inmutable de decisiones de IA: prompt enviado, tools invocadas,
 * respuesta cruda, tokens y motivo de ruteo. Reemplaza a agent_runs.
 */
export const aiDecisionLogs = pgTable(
  'ai_decision_logs',
  {
    id: id(),
    tenantId: uuid('tenant_id').notNull(), // sin FK: como audit_logs, sobrevive a la baja del tenant
    engine: text('engine').notNull(), // gemini | claude | router
    model: text('model').notNull(),
    task: text('task').notNull(),
    conversationId: uuid('conversation_id'),
    messageId: uuid('message_id'),
    inputRef: text('input_ref'),
    routingReason: text('routing_reason'),
    prompt: jsonb('prompt'),
    toolsInvoked: jsonb('tools_invoked').$type<Array<{ name: string; args: unknown; result?: unknown; error?: string }>>(),
    rawResponse: jsonb('raw_response'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    outcome: text('outcome').notNull(), // ok | refusal | error
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_decision_logs_conv_idx').on(t.tenantId, t.conversationId, t.createdAt)],
);
