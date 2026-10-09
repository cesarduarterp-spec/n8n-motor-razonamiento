import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Classification } from '../agents/agent.schemas.js';
import { route } from '../agents/router.js';
import { normalizeArPhone, validateExtraction } from '../contracts/contract-extraction.service.js';
import type { ContractExtraction } from '../contracts/extraction.schema.js';
import { normalizeMeta, normalizeTikTok, normalizeWhatsApp } from './normalizers.js';
import { verifyMetaSignature, verifyTikTokSignature } from './signatures.js';

describe('firmas', () => {
  const body = Buffer.from('{"a":1}');

  it('Meta: acepta HMAC válido y rechaza inválido', () => {
    const sig = 'sha256=' + createHmac('sha256', 's3cret').update(body).digest('hex');
    expect(verifyMetaSignature(body, sig, 's3cret')).toBe(true);
    expect(verifyMetaSignature(body, sig, 'otro')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 's3cret')).toBe(false);
  });

  it('TikTok: valida timestamp y firma', () => {
    const t = 1_760_000_000;
    const s = createHmac('sha256', 'tk').update(`${t}.`).update(body).digest('hex');
    expect(verifyTikTokSignature(body, `t=${t},s=${s}`, 'tk', t + 10)).toBe(true);
    expect(verifyTikTokSignature(body, `t=${t},s=${s}`, 'tk', t + 3600)).toBe(false); // replay
  });
});

describe('normalizadores', () => {
  it('WhatsApp: texto y nota de voz', () => {
    const out = normalizeWhatsApp({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '111' },
                contacts: [{ wa_id: '5491155550000', profile: { name: 'Laura' } }],
                messages: [
                  { from: '5491155550000', id: 'wamid.1', timestamp: '1760000000', type: 'text', text: { body: 'Hola' } },
                  { from: '5491155550000', id: 'wamid.2', timestamp: '1760000001', type: 'audio', audio: { id: 'MEDIA1', mime_type: 'audio/ogg; codecs=opus' } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ channel: 'whatsapp', accountExternalId: '111', contactName: 'Laura', contactPhone: '+5491155550000', text: 'Hola' });
    expect(out[1]).toMatchObject({ kind: 'audio', media: { id: 'MEDIA1' } });
  });

  it('Instagram: DM, ignora ecos y toma comentarios', () => {
    const out = normalizeMeta({
      object: 'instagram',
      entry: [
        {
          id: 'IG1',
          messaging: [
            { sender: { id: 'U1' }, timestamp: 1760000000000, message: { mid: 'm1', text: '¿Precio?' } },
            { sender: { id: 'IG1' }, timestamp: 1760000000000, message: { mid: 'm2', text: 'eco', is_echo: true } },
          ],
          changes: [{ field: 'comments', value: { id: 'C1', text: 'Info!', from: { id: 'U2', username: 'juan' }, media: { id: 'P1' } } }],
        },
      ],
    });
    expect(out.map((m) => m.externalMessageId)).toEqual(['m1', 'comment:C1']);
    expect(out[1]).toMatchObject({ channel: 'instagram', kind: 'comment', contactName: 'juan' });
  });

  it('TikTok: comentario con content serializado', () => {
    const out = normalizeTikTok({
      event: 'comment.create',
      user_openid: 'BIZ',
      create_time: 1760000000,
      content: JSON.stringify({ comment_id: 'X9', text: 'Me interesa', user_openid: 'U9' }),
    });
    expect(out[0]).toMatchObject({ channel: 'tiktok', accountExternalId: 'BIZ', kind: 'comment', text: 'Me interesa' });
  });
});

describe('router híbrido', () => {
  const base: Classification = {
    intent: 'property_search',
    confidence: 0.9,
    sentiment: 'neutral',
    urgency: 'normal',
    legalRiskSignals: [],
    entities: { operation: 'rent', propertyType: null, neighborhood: null, maxPrice: null, currency: null, bedrooms: null, propertyCode: null },
  };

  it('consultas comerciales van a Gemini', () => {
    expect(route(base, 'busco depto', { isTenantOrLandlord: false }).engine).toBe('gemini');
  });

  it('intenciones legales van a Claude', () => {
    expect(route({ ...base, intent: 'renegotiation' }, 'quiero rescindir', { isTenantOrLandlord: true }).engine).toBe('claude');
  });

  it('la red de seguridad por patrones escala aunque el clasificador falle', () => {
    expect(route(base, 'les voy a mandar una carta documento', { isTenantOrLandlord: true }).engine).toBe('claude');
  });

  it('pedido explícito de humano', () => {
    expect(route({ ...base, intent: 'human_handoff' }, 'quiero hablar con alguien', { isTenantOrLandlord: false }).engine).toBe('human');
  });
});

describe('extracción de contratos', () => {
  it('normaliza teléfonos argentinos', () => {
    expect(normalizeArPhone('011 15-5555-0000')).toBe('+5491155550000');
    expect(normalizeArPhone('+54 9 351 555-0000')).toBe('+5493515550000');
    expect(normalizeArPhone('123')).toBeNull();
  });

  it('marca para revisión extracciones con problemas', () => {
    const x = {
      documentType: 'locacion_vivienda',
      parties: [{ role: 'tenant', fullName: 'A', documentType: 'DNI', documentNumber: '1', address: null, email: null, phone: null }],
      property: { address: 'Calle 1', unit: null, city: null, province: null, use: 'vivienda' },
      term: { startDate: '2025-03-01', endDate: '2027-03-01', durationMonths: 24 },
      rent: { baseAmount: 500000, currency: 'ARS', paymentDueDay: 10, paymentMethod: null },
      adjustment: { indexType: 'IPC', frequencyMonths: 3, ipcLagMonths: 1, clauseText: '...' },
      deposit: null,
      latePayment: { dailyInterestPct: 0.1, graceDays: 5, clauseText: null },
      guarantees: [],
      expensesPaidBy: 'tenant',
      earlyTermination: { allowed: true, noticeDays: 30, penaltyDescription: null },
      legalRisks: [],
      missingFields: [],
      confidence: 0.95,
    } satisfies ContractExtraction;
    expect(validateExtraction(x)).toEqual(['No se identificó locador']);
  });
});
