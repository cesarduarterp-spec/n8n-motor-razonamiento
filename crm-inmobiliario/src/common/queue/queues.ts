/** Nombres de colas BullMQ y payloads tipados. */
export const Q = {
  WEBHOOKS: 'webhooks',
  AGENT: 'agent',
  CONTRACTS: 'contract-extraction',
  INDEXES: 'index-ingestion',
  BILLING: 'billing',
  OUTBOUND: 'outbound',
  MATCHING: 'matching',
} as const;

export type MatchingJob = { kind: 'lead'; tenantId: string; leadId: string } | { kind: 'property'; tenantId: string; propertyId: string };

export type WebhookJob =
  | { provider: 'whatsapp' | 'meta'; payload: unknown; receivedAt: string }
  | { provider: 'tiktok'; payload: unknown; receivedAt: string }
  | { provider: 'youtube'; payload: unknown; receivedAt: string };

export interface AgentJob {
  tenantId: string;
  conversationId: string;
  contactId: string;
  messageId: string;
}

export interface ContractExtractionJob {
  tenantId: string;
  documentId: string;
}

export type IndexJob = { kind: 'icl' } | { kind: 'ipc' };

export type BillingJob =
  | { kind: 'fanout-daily' }
  | { kind: 'apply-adjustments'; tenantId: string }
  | { kind: 'mark-overdue'; tenantId: string }
  | { kind: 'settle-month'; tenantId: string; periodMonth: string };

export interface OutboundJob {
  tenantId: string;
  conversationId: string;
  text: string;
  author: 'agent_gemini' | 'agent_claude' | 'human';
}

/** Opciones por defecto: reintentos exponenciales y retención acotada para no inflar Redis. */
export const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;
