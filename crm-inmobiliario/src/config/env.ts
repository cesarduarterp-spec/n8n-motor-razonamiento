import { z } from 'zod';

/**
 * Validación de variables de entorno al arranque. Si falta algo crítico el
 * proceso no levanta (fail-fast), en lugar de fallar en el primer webhook.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_BASE_URL: z.string().url(),

  // PostgreSQL: dos roles. APP respeta RLS; SYSTEM tiene BYPASSRLS y solo lo
  // usan workers/cron y la resolución de tenant de los webhooks.
  DATABASE_URL: z.string().url(),
  DATABASE_SYSTEM_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('crm-inmobiliario'),
  // Clave maestra AES-256-GCM (32 bytes en base64) para cifrar secretos por tenant.
  MASTER_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
    message: 'MASTER_ENCRYPTION_KEY debe ser 32 bytes en base64',
  }),

  // LLMs globales (un tenant puede sobreescribirlos con sus propias keys).
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-opus-5-5'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().default(768),

  // Meta (WhatsApp Cloud API + Messenger + Instagram).
  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  META_GRAPH_VERSION: z.string().default('v23.0'),

  TIKTOK_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),

  // Google Calendar (booker de visitas): OAuth por asesor.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),

  // Fuentes de índices.
  BCRA_API_BASE: z.string().url().default('https://api.bcra.gob.ar/estadisticas/v3.0/monetarias'),
  BCRA_ICL_VARIABLE_ID: z.coerce.number().int().default(40),
  INDEC_IPC_SERIES_URL: z
    .string()
    .url()
    .default('https://apis.datos.gob.ar/series/api/series/?ids=148.3_INIVELNAL_DICI_M_26&format=json&limit=5000'),

  STORAGE_DIR: z.string().default('/var/lib/crm/uploads'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Configuración inválida:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
