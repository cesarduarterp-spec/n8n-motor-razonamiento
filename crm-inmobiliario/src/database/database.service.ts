import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
/** Transacción con `app.tenant_id` ya fijado: todo lo que corra adentro queda aislado por RLS. */
export type TenantTx = Parameters<Parameters<Db['transaction']>[0]>[0];

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly appPool = new pg.Pool({ connectionString: env().DATABASE_URL, max: 20 });
  private readonly systemPool = new pg.Pool({ connectionString: env().DATABASE_SYSTEM_URL, max: 5 });

  /** Conexión con rol crm_app (RLS forzada). Solo usar vía `withTenant`. */
  private readonly app: Db = drizzle(this.appPool, { schema });
  /**
   * Conexión con rol crm_system (BYPASSRLS). Restringida a: enrutamiento de
   * webhooks (channel_accounts), ingesta de índices globales y fan-out de
   * jobs por tenant. Nunca exponer en controladores de negocio.
   */
  readonly system: Db = drizzle(this.systemPool, { schema });

  /**
   * Ejecuta `fn` en una transacción con `SET LOCAL app.tenant_id`. SET LOCAL
   * muere con la transacción, así que no hay fuga de contexto entre requests
   * que reutilizan la misma conexión del pool.
   */
  async withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('tenantId inválido');
    return this.app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });
  }

  async onModuleDestroy() {
    await Promise.all([this.appPool.end(), this.systemPool.end()]);
  }
}
