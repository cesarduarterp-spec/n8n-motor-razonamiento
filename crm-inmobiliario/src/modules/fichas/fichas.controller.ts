import { BadRequestException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type AuthUser, CurrentUser, Public } from '../../common/auth/auth.js';
import { type FichaFormat, FichasService } from './fichas.service.js';
import type { FichaVariant } from './public-listing.js';

const kinds = { properties: 'property', developments: 'development' } as const;

function kindOf(entity: string): 'property' | 'development' {
  const k = kinds[entity as keyof typeof kinds];
  if (!k) throw new NotFoundException();
  return k;
}

function parseOpts(variant?: string, format?: string): { variant: FichaVariant; format: FichaFormat } {
  const v = variant ?? 'public';
  const f = format ?? 'html';
  if (v !== 'public' && v !== 'neutral') throw new BadRequestException('variant debe ser public | neutral');
  if (f !== 'json' && f !== 'html' && f !== 'pdf') throw new BadRequestException('format debe ser json | html | pdf');
  return { variant: v, format: f };
}

function send(res: Response, out: { contentType: string; body: unknown }, filename: string) {
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('X-Robots-Tag', 'noindex');
  if (out.contentType === 'application/pdf') res.setHeader('Content-Disposition', `inline; filename="${filename}.pdf"`);
  if (out.contentType.startsWith('text/html')) {
    // La ficha no ejecuta scripts: CSP estricta por las dudas.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; frame-ancestors 'none'");
  }
  res.send(out.contentType === 'application/json' ? JSON.stringify(out.body) : out.body);
}

@Controller()
export class FichasController {
  constructor(private readonly fichas: FichasService) {}

  /** GET /properties/:id/ficha?variant=public|neutral&format=html|pdf|json (también /developments/:id/ficha) */
  @Get(':entity/:id/ficha')
  async ficha(
    @CurrentUser() user: AuthUser,
    @Param('entity') entity: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('variant') variant: string | undefined,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ) {
    const opts = parseOpts(variant, format);
    const out = await this.fichas.render({ tenantId: user.tenantId, kind: kindOf(entity), id, variant: opts.variant }, opts.format, 'api');
    send(res, out, `ficha-${opts.variant}-${id.slice(0, 8)}`);
  }

  /** Link firmado para compartir (cliente: variant=public; colegas de red: variant=neutral). */
  @Post(':entity/:id/ficha-links')
  link(
    @CurrentUser() user: AuthUser,
    @Param('entity') entity: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('variant') variant?: string,
    @Query('days') days?: string,
  ) {
    const opts = parseOpts(variant, 'html');
    const d = Math.min(Math.max(Number(days ?? 30) || 30, 1), 180);
    return this.fichas.shareLink({ tenantId: user.tenantId, kind: kindOf(entity), id, variant: opts.variant }, d);
  }

  /** Acceso público por token (sin login). El token fija tenant, entidad y variante: no se pueden alterar. */
  @Public()
  @Get('public/fichas/:token')
  async publicFicha(@Param('token') token: string, @Query('format') format: string | undefined, @Res() res: Response) {
    const target = await this.fichas.verifyLink(token).catch(() => {
      throw new NotFoundException('Ficha inexistente o vencida');
    });
    const opts = parseOpts(target.variant, format);
    send(res, await this.fichas.render(target, opts.format, 'link'), `ficha-${target.id.slice(0, 8)}`);
  }
}
