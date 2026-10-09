import { z } from 'zod';

/** Taxonomía de intenciones del frontline. Las marcadas con ⚖ escalan a Claude. */
export const Intent = z.enum([
  'property_search', // búsqueda de catálogo / consulta por una publicación
  'visit_request', // coordinar visita
  'payment_receipt', // envía comprobante
  'payment_status', // cuánto debo / cuándo vence / CBU
  'maintenance_request', // reparaciones, roturas
  'contract_claim', // ⚖ reclamo sobre cláusulas, depósito, expensas, aumentos mal calculados
  'legal_dispute', // ⚖ amenaza de acciones, carta documento, desalojo, abogado
  'renegotiation', // ⚖ pedido de rebaja, prórroga, rescisión anticipada
  'delinquency', // ⚖ mora declarada ("no voy a poder pagar")
  'human_handoff', // pide hablar con una persona
  'greeting_smalltalk',
  'other',
]);
export type Intent = z.infer<typeof Intent>;

export const SPECIALIST_INTENTS: ReadonlySet<Intent> = new Set(['contract_claim', 'legal_dispute', 'renegotiation', 'delinquency']);

export const Classification = z.object({
  intent: Intent,
  confidence: z.number().describe('0 a 1'),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'hostile']),
  urgency: z.enum(['low', 'normal', 'high']),
  legalRiskSignals: z.array(z.string()).describe('Frases que sugieren conflicto legal o contractual'),
  entities: z.object({
    operation: z.enum(['sale', 'rent', 'temporary_rent']).nullable(),
    propertyType: z.string().nullable(),
    neighborhood: z.string().nullable(),
    maxPrice: z.number().nullable(),
    currency: z.enum(['ARS', 'USD']).nullable(),
    bedrooms: z.number().int().nullable(),
    propertyCode: z.string().nullable(),
  }),
});
export type Classification = z.infer<typeof Classification>;

export const ReceiptExtraction = z.object({
  isPaymentReceipt: z.boolean(),
  amount: z.number().nullable(),
  currency: z.enum(['ARS', 'USD']).nullable(),
  paidOn: z.string().nullable().describe('YYYY-MM-DD'),
  operationNumber: z.string().nullable(),
  payerName: z.string().nullable(),
  payerDocument: z.string().nullable(),
  bank: z.string().nullable().describe('Banco o billetera (Mercado Pago, Ualá, etc.)'),
  destinationAccount: z.string().nullable().describe('CBU/CVU/alias destino'),
  legibility: z.enum(['clear', 'partial', 'illegible']),
});
export type ReceiptExtraction = z.infer<typeof ReceiptExtraction>;

export const MemoryUpdate = z.object({
  summary: z.string().describe('Resumen acumulado de la relación con el contacto (máx. 120 palabras)'),
  facts: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .describe('Hechos estables: presupuesto, zona buscada, mascotas, grupo familiar, fecha de mudanza, etc.'),
});

/** Salida estructurada del especialista (Claude). */
export const SpecialistDecision = z.object({
  replyToContact: z
    .string()
    .describe('Mensaje para el contacto. Empático, claro, sin asumir responsabilidad legal ni hacer promesas.'),
  autoSendReply: z
    .boolean()
    .describe('true solo si el mensaje es informativo y de bajo riesgo; false si requiere revisión humana'),
  riskLevel: z.enum(['low', 'medium', 'high']),
  internalNote: z.string().describe('Análisis para el equipo: cláusulas involucradas, cálculo, próximos pasos'),
  draft: z
    .object({
      kind: z.enum(['late_payment_notice', 'formal_notice', 'renegotiation_proposal', 'reply']),
      content: z.string(),
    })
    .nullable()
    .describe('Documento formal a revisar por un humano antes de enviar'),
});
export type SpecialistDecision = z.infer<typeof SpecialistDecision>;
