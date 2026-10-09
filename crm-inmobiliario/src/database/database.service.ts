import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { RequestContext } from '../common/audit/request-context.js';
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
   * Ejecuta `fn` en una transacción con el contexto de seguridad fijado por
   * SET LOCAL (muere con la transacción: no hay fuga entre requests que
   * reutilizan la conexión):
   *   app.tenant_id        → RLS
   *   app.actor_* / ip / … → actor que registran los triggers de auditoría
   *   app.can_view_private → habilita la capa privada (solo admin/broker humanos)
   *   app.include_deleted  → permite leer filas con soft delete (papelera/auditoría)
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: TenantTx) => Promise<T>,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<T> {
    if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('tenantId inválido');
    const ctx = RequestContext.current();
    return this.app.transaction(async (tx) => {
      await tx.execute(sql`select
        set_config('app.tenant_id', ${tenantId}, true),
        set_config('app.actor_type', ${ctx?.actorType ?? 'system'}, true),
        set_config('app.user_id', ${ctx?.userId ?? ''}, true),
        set_config('app.agent_id', ${ctx?.agentId ?? ''}, true),
        set_config('app.ip', ${ctx?.ip ?? ''}, true),
        set_config('app.user_agent', ${ctx?.userAgent ?? ''}, true),
        set_config('app.request_id', ${ctx?.requestId ?? ''}, true),
        set_config('app.can_view_private', ${RequestContext.canViewPrivate(ctx) ? 'on' : 'off'}, true),
        set_config('app.include_deleted', ${opts.includeDeleted ? 'on' : 'off'}, true)`);
      return fn(tx);
    });
  }

  async onModuleDestroy() {
    await Promise.all([this.appPool.end(), this.systemPool.end()]);
  }
}
