import { createHmac, timingSafeEqual } from 'node:crypto';

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/** Meta (WhatsApp/Messenger/Instagram): X-Hub-Signature-256: sha256=<hmac(app_secret, raw_body)> */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqualHex(header.slice(7), expected);
}

/**
 * TikTok: TikTok-Signature: t=<unix>,s=<hmac(client_secret, `${t}.${raw_body}`)>
 * Rechaza firmas con más de 5 minutos de antigüedad (anti-replay).
 */
export function verifyTikTokSignature(rawBody: Buffer, header: string | undefined, clientSecret: string, nowSec = Date.now() / 1000): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!parts.s || !Number.isFinite(t) || Math.abs(nowSec - t) > 300) return false;
  const expected = createHmac('sha256', clientSecret).update(`${parts.t}.`).update(rawBody).digest('hex');
  return safeEqualHex(parts.s, expected);
}
