import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { type AuthUser, CurrentUser, Public, Roles } from '../../common/auth/auth.js';
import { AgendaService } from './agenda.service.js';
import { BookingService } from './booking.service.js';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
};

const Book = z.object({ leadId: z.string().uuid(), propertyId: z.string().uuid(), start: z.string().datetime() });
const Block = z.object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), reason: z.string().max(200).optional(), userId: z.string().uuid().optional() });

const isManager = (u: AuthUser) => u.role === 'admin' || u.role === 'broker';
/** Un asesor gestiona su propia agenda; admin/broker pueden gestionar la de cualquiera. */
const targetUser = (u: AuthUser, requested?: string) => {
  if (requested && requested !== u.userId && !isManager(u)) throw new ForbiddenException('Solo podés gestionar tu propia agenda');
  return requested ?? u.userId;
};

const sendIcs = (res: Response, body: string, filename: string) => {
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${filename}.ics"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(body);
};

@Controller()
export class BookingController {
  constructor(
    private readonly booking: BookingService,
    private readonly agenda: AgendaService,
  ) {}

  // ───────────── Visitas ─────────────

  @Get('visits/slots')
  slots(@CurrentUser() user: AuthUser, @Query('leadId', ParseUUIDPipe) leadId: string, @Query('propertyId', ParseUUIDPipe) propertyId: string) {
    return this.booking.availableSlots(user.tenantId, leadId, { propertyId });
  }

  @Post('visits')
  @Roles('admin', 'broker', 'sales_agent')
  book(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(Book, body);
    return this.booking.book(user.tenantId, b.leadId, { propertyId: b.propertyId }, b.start, `user:${user.userId}`);
  }

  @Post('visits/:id/cancel')
  @Roles('admin', 'broker', 'sales_agent')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: { reason?: string }) {
    return this.booking.cancel(user.tenantId, id, body?.reason ?? 'Cancelada por el asesor');
  }

  /** "Agregar a mi calendario": archivo .ics de una visita. */
  @Get('visits/:id/ics')
  async visitIcs(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendIcs(res, await this.agenda.visitIcs(user.tenantId, id), `visita-${id.slice(0, 8)}`);
  }

  // ───────────── Agenda del asesor ─────────────

  /** Genera (o regenera, revocando el anterior) el link iCal privado para suscribirse desde el celular. */
  @Post('agenda/feed-link')
  feedLink(@CurrentUser() user: AuthUser, @Query('userId') userId?: string) {
    return this.agenda.rotateFeedLink(user.tenantId, targetUser(user, userId));
  }

  @Delete('agenda/feed-link')
  revokeFeed(@CurrentUser() user: AuthUser, @Query('userId') userId?: string) {
    return this.agenda.revokeFeedLink(user.tenantId, targetUser(user, userId));
  }

  /** Conecta el calendario personal pegando su "dirección secreta en formato iCal" (solo lectura, sin OAuth). */
  @Put('agenda/external-calendar')
  external(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const { url, userId } = parse(z.object({ url: z.string().url(), userId: z.string().uuid().optional() }), body);
    return this.agenda.setExternalCalendar(user.tenantId, targetUser(user, userId), url);
  }

  @Delete('agenda/external-calendar')
  removeExternal(@CurrentUser() user: AuthUser, @Query('userId') userId?: string) {
    return this.agenda.removeExternalCalendar(user.tenantId, targetUser(user, userId));
  }

  @Get('agenda/blocks')
  blocks(@CurrentUser() user: AuthUser, @Query('userId') userId?: string) {
    return this.agenda.listBlocks(user.tenantId, targetUser(user, userId));
  }

  /** Bloquea un rango (vacaciones, trámites): el bot no ofrece esos horarios. */
  @Post('agenda/blocks')
  addBlock(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parse(Block, body);
    return this.agenda.addBlock(user.tenantId, targetUser(user, b.userId), new Date(b.startsAt), new Date(b.endsAt), b.reason);
  }

  @Delete('agenda/blocks/:id')
  removeBlock(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.agenda.removeBlock(user.tenantId, user.userId, id, isManager(user));
  }

  /** Feed público por token (lo consultan Google/Apple/Outlook cada ~15 min-24 h). */
  @Public()
  @Get('public/calendars/:file')
  async feed(@Param('file') file: string, @Res() res: Response) {
    const ics = await this.agenda.feed(file.replace(/\.ics$/, ''));
    if (!ics) throw new NotFoundException();
    sendIcs(res, ics, 'visitas');
  }
}
