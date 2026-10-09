import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import type { AuthUser } from '../auth/auth.js';

/**
 * Quién está actuando. Viaja por AsyncLocalStorage desde el borde (request
 * HTTP o job de BullMQ) hasta `DatabaseService.withTenant`, que lo traslada a
 * la sesión de Postgres con SET LOCAL. Los triggers de auditoría lo leen de
 * ahí: el actor no depende de que cada servicio "se acuerde" de loguear.
 */
export interface ActorContext {
  actorType: 'user' | 'agent' | 'system' | 'public';
  userId?: string;
  role?: AuthUser['role'];
  agentId?: string; // gemini-frontline | claude-specialist | booker | matcher | billing | ...
  ip?: string;
  userAgent?: string;
  requestId: string;
}

const storage = new AsyncLocalStorage<ActorContext>();

export const RequestContext = {
  current(): ActorContext | undefined {
    return storage.getStore();
  },
  run<T>(ctx: Omit<ActorContext, 'requestId'> & { requestId?: string }, fn: () => T): T {
    return storage.run({ ...ctx, requestId: ctx.requestId ?? randomUUID() }, fn);
  },
  /** Ejecuta `fn` como un agente IA, heredando el request id del contexto actual (trazabilidad end-to-end). */
  asAgent<T>(agentId: string, fn: () => T): T {
    const parent = storage.getStore();
    return storage.run({ actorType: 'agent', agentId, requestId: parent?.requestId ?? randomUUID() }, fn);
  },
  /** Solo admin/broker humanos ven la capa privada; agentes, público y sistema nunca. */
  canViewPrivate(ctx = storage.getStore()): boolean {
    return ctx?.actorType === 'user' && (ctx.role === 'admin' || ctx.role === 'broker');
  },
};

function clientIp(req: Request): string | undefined {
  // Detrás de proxy: app.set('trust proxy', ...) hace que req.ip sea la IP real.
  return req.ip ?? req.socket.remoteAddress ?? undefined;
}

/** Interceptor global: abre el contexto de actor para cada request HTTP (después del AuthGuard). */
@Injectable()
export class AuditContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const requestId = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) ?? randomUUID();
    const actor: ActorContext = req.user
      ? { actorType: 'user', userId: req.user.userId, role: req.user.role, requestId }
      : { actorType: 'public', requestId };
    actor.ip = clientIp(req);
    actor.userAgent = req.headers['user-agent']?.slice(0, 512);

    return new Observable((subscriber) => {
      storage.run(actor, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
