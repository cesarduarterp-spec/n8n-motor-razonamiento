import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { type AuthUser, CurrentUser, Public, Roles } from '../../common/auth/auth.js';
import { RequestContext } from '../../common/audit/request-context.js';
import { env } from '../../config/env.js';
import { DatabaseService } from '../../database/database.service.js';
import { users } from '../../database/schema.js';
import { TenantSecretsService } from '../tenants/tenant-secrets.service.js';
import { BookingService } from './booking.service.js';
import { GoogleCalendarClient, refreshTokenSecret } from './google-calendar.client.js';

const secret = () => new TextEncoder().encode(env().JWT_SECRET);

const Book = z.object({ leadId: z.string().uuid(), propertyId: z.string().uuid(), start: z.string().datetime() });

@Controller()
export class BookingController {
  constructor(
    private readonly booking: BookingService,
    private readonly calendar: GoogleCalendarClient,
    private readonly secrets: TenantSecretsService,
    private readonly db: DatabaseService,
  ) {}

  @Get('visits/slots')
  slots(@CurrentUser() user: AuthUser, @Query('leadId', ParseUUIDPipe) leadId: string, @Query('propertyId', ParseUUIDPipe) propertyId: string) {
    return this.booking.availableSlots(user.tenantId, leadId, { propertyId });
  }

  @Post('visits')
  @Roles('admin', 'broker', 'sales_agent')
  book(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const parsed = Book.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.booking.book(user.tenantId, parsed.data.leadId, { propertyId: parsed.data.propertyId }, parsed.data.start, `user:${user.userId}`);
  }

  @Post('visits/:id/cancel')
  @Roles('admin', 'broker', 'sales_agent')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: { reason?: string }) {
    return this.booking.cancel(user.tenantId, id, body?.reason ?? 'Cancelada por el asesor');
  }

  /** Paso 1 del OAuth: URL de consentimiento de Google para conectar la agenda del asesor. */
  @Get('integrations/google/connect')
  async connect(@CurrentUser() user: AuthUser) {
    if (!this.calendar.isConfigured()) throw new BadRequestException('Google OAuth no configurado (GOOGLE_OAUTH_CLIENT_ID/SECRET)');
    const state = await new SignJWT({ tid: user.tenantId, aud: 'google-oauth' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.userId)
      .setExpirationTime('10m')
      .sign(secret());
    return { url: this.calendar.authUrl(state) };
  }

  /** Paso 2: Google redirige acá; se guarda el refresh token cifrado del asesor. */
  @Public()
  @Get('integrations/google/callback')
  async callback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const { payload } = await jwtVerify(state, secret(), { audience: 'google-oauth' }).catch(() => {
      throw new BadRequestException('state inválido o vencido');
    });
    const tenantId = String(payload.tid);
    const userId = String(payload.sub);
    const { refreshToken } = await this.calendar.exchangeCode(code);
    await RequestContext.run({ actorType: 'user', userId }, async () => {
      await this.secrets.set(tenantId, refreshTokenSecret(userId), refreshToken);
      await this.db.withTenant(tenantId, (tx) => tx.update(users).set({ calendarId: 'primary' }).where(eq(users.id, userId)));
    });
    res.type('text/plain').send('Google Calendar conectado. Ya podés cerrar esta ventana.');
  }
}
