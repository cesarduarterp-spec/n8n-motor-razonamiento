import { Body, Controller, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { issueToken, Public, verifyPassword } from '../../common/auth/auth.js';
import { DatabaseService } from '../../database/database.service.js';
import { tenants, users } from '../../database/schema.js';

const Login = z.object({ tenant: z.string(), email: z.string().email(), password: z.string() });

@Controller('auth')
export class AuthController {
  constructor(private readonly db: DatabaseService) {}

  /** Login por (slug de inmobiliaria, email, password). Previo al contexto de tenant: usa rol SYSTEM solo para esta búsqueda. */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown) {
    const parsed = Login.safeParse(body);
    if (!parsed.success) throw new UnauthorizedException();
    const { tenant, email, password } = parsed.data;

    const [row] = await this.db.system
      .select({ user: users, tenantActive: tenants.active })
      .from(users)
      .innerJoin(tenants, eq(tenants.id, users.tenantId))
      .where(and(eq(tenants.slug, tenant), eq(users.email, email.toLowerCase()), eq(users.active, true)));

    // Mismo error para usuario inexistente y password incorrecta.
    if (!row || !row.tenantActive || !(await verifyPassword(password, row.user.passwordHash))) {
      throw new UnauthorizedException('Credenciales inválidas');
    }
    const token = await issueToken({ userId: row.user.id, tenantId: row.user.tenantId, role: row.user.role });
    return { accessToken: token, role: row.user.role };
  }
}
