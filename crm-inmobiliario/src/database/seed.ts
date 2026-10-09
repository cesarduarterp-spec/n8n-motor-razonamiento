import { hashPassword } from '../common/auth/auth.js';
import { sealSecret } from '../common/crypto/secret-box.js';
import { DatabaseService } from './database.service.js';
import { channelAccounts, tenantSecrets, tenants, users } from './schema.js';

/**
 * Alta de una inmobiliaria con su admin y (opcional) su número de WhatsApp.
 *   SEED_SLUG=demo SEED_ADMIN_EMAIL=admin@demo.com SEED_ADMIN_PASSWORD=... \
 *   SEED_WA_PHONE_NUMBER_ID=123 SEED_WA_TOKEN=EAAG... node dist/database/seed.js
 */
const slug = process.env.SEED_SLUG ?? 'demo';
const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@demo.com').toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD;
if (!password || password.length < 12) throw new Error('SEED_ADMIN_PASSWORD (mín. 12 caracteres) es requerido');

const db = new DatabaseService();
const [tenant] = await db.system
  .insert(tenants)
  .values({
    name: process.env.SEED_NAME ?? 'Inmobiliaria Demo',
    slug,
    settings: { agencyCommissionPct: 5, defaultGraceDays: 5, defaultDailyPenaltyPct: 0.1, timezone: 'America/Argentina/Buenos_Aires' },
  })
  .returning({ id: tenants.id });
const tenantId = tenant!.id;

await db.system.insert(users).values({ tenantId, email, fullName: 'Administrador', passwordHash: await hashPassword(password), role: 'admin' });

if (process.env.SEED_WA_PHONE_NUMBER_ID && process.env.SEED_WA_TOKEN) {
  await db.system.insert(tenantSecrets).values({ tenantId, name: 'whatsapp_access_token', ciphertext: sealSecret(process.env.SEED_WA_TOKEN, tenantId) });
  await db.system.insert(channelAccounts).values({
    tenantId,
    channel: 'whatsapp',
    externalAccountId: process.env.SEED_WA_PHONE_NUMBER_ID,
    accessTokenSecret: 'whatsapp_access_token',
    displayName: 'WhatsApp principal',
  });
}

await db.onModuleDestroy();
console.log(`Tenant ${slug} (${tenantId}) creado con admin ${email}`);
