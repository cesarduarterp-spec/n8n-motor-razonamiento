import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * Cifrado AES-256-GCM de secretos por tenant. Formato: v1.<iv>.<tag>.<ciphertext> (base64url).
 * El tenantId va como AAD: un ciphertext copiado a otro tenant no descifra.
 */
export function sealSecret(plaintext: string, tenantId: string): string {
  const key = Buffer.from(env().MASTER_ENCRYPTION_KEY, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(tenantId));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), enc].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function openSecret(sealed: string, tenantId: string): string {
  const [version, iv, tag, enc] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !enc) throw new Error('Formato de secreto inválido');
  const key = Buffer.from(env().MASTER_ENCRYPTION_KEY, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(tenantId));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
}
