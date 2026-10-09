import { z } from 'zod';

/**
 * Payload estructurado que Claude devuelve al leer un contrato de locación.
 * Se usa como `output_config.format` (structured outputs): la respuesta
 * llega validada contra este esquema.
 */
const isoDate = z.string().describe('Fecha en formato YYYY-MM-DD');

export const ContractExtraction = z.object({
  documentType: z
    .enum(['locacion_vivienda', 'locacion_comercial', 'locacion_temporaria', 'otro'])
    .describe('Tipo de contrato detectado'),
  parties: z
    .array(
      z.object({
        role: z.enum(['landlord', 'tenant', 'guarantor']),
        fullName: z.string(),
        documentType: z.enum(['DNI', 'CUIT', 'CUIL', 'PASAPORTE', 'OTRO']).nullable(),
        documentNumber: z.string().nullable().describe('Solo dígitos, sin puntos ni guiones'),
        address: z.string().nullable(),
        email: z.string().nullable(),
        phone: z.string().nullable(),
      }),
    )
    .describe('Locadores, locatarios y garantes/fiadores'),
  property: z.object({
    address: z.string(),
    unit: z.string().nullable(),
    city: z.string().nullable(),
    province: z.string().nullable(),
    use: z.enum(['vivienda', 'comercial', 'mixto', 'otro']),
  }),
  term: z.object({
    startDate: isoDate,
    endDate: isoDate,
    durationMonths: z.number().int(),
  }),
  rent: z.object({
    baseAmount: z.number().describe('Canon locativo inicial mensual'),
    currency: z.enum(['ARS', 'USD']),
    paymentDueDay: z.number().int().describe('Día del mes de vencimiento (1-31)'),
    paymentMethod: z.string().nullable(),
  }),
  adjustment: z.object({
    indexType: z.enum(['ICL', 'IPC', 'FIXED', 'CASA_PROPIA', 'OTHER']),
    frequencyMonths: z.number().int().describe('Cada cuántos meses se actualiza (0 si no se actualiza)'),
    ipcLagMonths: z
      .number()
      .int()
      .nullable()
      .describe('Para IPC: meses de rezago pactados respecto del mes de actualización (1 = mes anterior)'),
    clauseText: z.string().describe('Transcripción literal de la cláusula de actualización'),
  }),
  deposit: z
    .object({ amount: z.number(), currency: z.enum(['ARS', 'USD']), refundConditions: z.string().nullable() })
    .nullable(),
  latePayment: z.object({
    dailyInterestPct: z.number().nullable().describe('Interés punitorio diario en % (ej. 0.5 = 0,5% diario)'),
    graceDays: z.number().int().nullable(),
    clauseText: z.string().nullable(),
  }),
  guarantees: z.array(z.object({ type: z.string(), description: z.string() })),
  expensesPaidBy: z.enum(['tenant', 'landlord', 'shared', 'unspecified']),
  earlyTermination: z.object({
    allowed: z.boolean(),
    noticeDays: z.number().int().nullable(),
    penaltyDescription: z.string().nullable(),
  }),
  legalRisks: z
    .array(
      z.object({
        clause: z.string(),
        issue: z.string(),
        severity: z.enum(['low', 'medium', 'high']),
        legalBasis: z.string().nullable().describe('Norma aplicable (CCyCN, Ley 27.551, DNU 70/2023, etc.)'),
      }),
    )
    .describe('Cláusulas ambiguas, abusivas, contradictorias o potencialmente nulas'),
  missingFields: z.array(z.string()).describe('Campos que no figuran o son ilegibles'),
  confidence: z.number().describe('Confianza global de la extracción entre 0 y 1'),
});

export type ContractExtraction = z.infer<typeof ContractExtraction>;
