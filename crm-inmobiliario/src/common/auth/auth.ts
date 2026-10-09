import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { jwtVerify, SignJWT } from 'jose';
import type { Request } from 'express';
import { env } from '../../config/env.js';

export type Role = 'admin' | 'broker' | 'sales_agent' | 'back_office';

export interface AuthUser {
  userId: string;
  tenantId: string;
  role: Role;
}

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const secret = () => new TextEncoder().encode(env().JWT_SECRET);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

export async function issueToken(user: AuthUser): Promise<string> {
  return new SignJWT({ tid: user.tenantId, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.userId)
    .setIssuer(env().JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret());
}

const ROLES_KEY = 'roles';
const PUBLIC_KEY = 'public';

/** Restringe un handler a ciertos roles. Sin @Roles, cualquier usuario autenticado del tenant accede. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
/** Marca un endpoint como público (webhooks, login, health). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  if (!req.user) throw new UnauthorizedException();
  return req.user;
});

/**
 * Guard global: valida el JWT, carga el AuthUser (tenantId sale SIEMPRE del
 * token, nunca de headers/body) y aplica RBAC por rol.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();

    try {
      const { payload } = await jwtVerify(header.slice(7), secret(), { issuer: env().JWT_ISSUER });
      req.user = { userId: String(payload.sub), tenantId: String(payload.tid), role: payload.role as Role };
    } catch {
      throw new UnauthorizedException();
    }

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(req.user.role)) throw new ForbiddenException('Rol sin permisos');
    return true;
  }
}
