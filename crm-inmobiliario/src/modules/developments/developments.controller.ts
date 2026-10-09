import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { type AuthUser, CurrentUser, Roles } from '../../common/auth/auth.js';
import { DevelopmentsService } from './developments.service.js';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
};

const Media = z.array(
  z.object({
    type: z.enum(['photo', 'video', 'tour360', 'floorplan']),
    url: z.string().url().startsWith('https://'),
    provider: z.enum(['youtube', 'matterport', 'kuula', 'other']).optional(),
    caption: z.string().optional(),
  }),
);

const CreateDevelopment = z.object({
  code: z.string().min(1),
  name: z.string().min(2),
  kind: z.enum(['building', 'lot_subdivision', 'condominium', 'gated_community', 'office_park']),
  constructionStatus: z.enum(['pozo', 'preventa', 'en_construccion', 'entrega_inmediata', 'terminado']),
  deliveryDate: z.string().date().optional(),
  description: z.string().optional(),
  amenities: z.array(z.string()).default([]),
  media: Media.default([]),
  neighborhood: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
  address: z.string().optional(),
  showExactAddress: z.boolean().default(false),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  published: z.boolean().default(false),
});

const Unit = z.object({
  unitCode: z.string().min(1),
  typology: z.string().min(1),
  propertyType: z.string().default('departamento'),
  floor: z.number().int().optional(),
  orientation: z.string().optional(),
  rooms: z.number().int().optional(),
  bedrooms: z.number().int().optional(),
  bathrooms: z.number().int().optional(),
  coveredM2: z.number().positive().optional(),
  totalM2: z.number().positive().optional(),
  price: z.number().positive().optional(),
  currency: z.enum(['ARS', 'USD']).default('USD'),
  operation: z.enum(['sale', 'rent']).default('sale'),
});

const PriceList = z.object({
  name: z.string(),
  currency: z.enum(['ARS', 'USD']),
  validFrom: z.string().date(),
  validTo: z.string().date().optional(),
  adjustmentRule: z.string().optional(),
  financingPlans: z.array(z.object({ name: z.string(), downPaymentPct: z.number(), installments: z.number().int(), notes: z.string().optional() })).optional(),
  items: z.array(z.object({ unitId: z.string().uuid(), price: z.number().positive() })).min(1),
});

const Private = z.object({
  ownerContactId: z.string().uuid().nullish(),
  commissionPct: z.number().min(0).max(100).nullish(),
  commissionNotes: z.string().nullish(),
  exclusive: z.boolean().default(false),
  exclusiveUntil: z.string().date().nullish(),
  keysLocation: z.string().nullish(),
  keysHolder: z.string().nullish(),
  internalNotes: z.string().nullish(),
  originAppraisal: z.number().positive().nullish(),
  originAppraisalCurrency: z.enum(['ARS', 'USD']).nullish(),
  originAppraisalDate: z.string().date().nullish(),
  appraiser: z.string().nullish(),
});

const toPrivate = (p: z.infer<typeof Private>) => ({
  ...p,
  commissionPct: p.commissionPct?.toFixed(2) ?? null,
  originAppraisal: p.originAppraisal?.toFixed(2) ?? null,
});

@Controller()
export class DevelopmentsController {
  constructor(private readonly developments: DevelopmentsService) {}

  @Get('developments')
  list(@CurrentUser() user: AuthUser) {
    return this.developments.list(user.tenantId);
  }

  @Post('developments')
  @Roles('admin', 'broker')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const d = parse(CreateDevelopment, body);
    return this.developments.create(user.tenantId, { ...d, latitude: d.latitude?.toFixed(6), longitude: d.longitude?.toFixed(6) });
  }

  @Get('developments/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.developments.get(user.tenantId, id);
  }

  @Post('developments/:id/units')
  @Roles('admin', 'broker')
  addUnit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.developments.addUnit(user.tenantId, id, parse(Unit, body));
  }

  @Patch('units/:unitId/status')
  @Roles('admin', 'broker', 'sales_agent')
  unitStatus(@CurrentUser() user: AuthUser, @Param('unitId', ParseUUIDPipe) unitId: string, @Body() body: unknown) {
    const { status } = parse(z.object({ status: z.enum(['available', 'reserved', 'sold', 'blocked']) }), body);
    return this.developments.setUnitStatus(user.tenantId, unitId, status);
  }

  @Post('developments/:id/price-lists')
  @Roles('admin', 'broker')
  priceList(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.developments.publishPriceList(user.tenantId, id, parse(PriceList, body));
  }

  // ── Capa privada: solo admin/broker (RBAC) + RLS restrictiva + PRIVATE_ACCESS en el audit trail ──

  @Get('properties/:id/private')
  @Roles('admin', 'broker')
  getPropertyPrivate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.developments.getPrivate(user.tenantId, { propertyId: id });
  }

  @Put('properties/:id/private')
  @Roles('admin', 'broker')
  putPropertyPrivate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.developments.upsertPrivate(user.tenantId, { propertyId: id }, toPrivate(parse(Private, body)));
  }

  @Get('developments/:id/private')
  @Roles('admin', 'broker')
  getDevelopmentPrivate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.developments.getPrivate(user.tenantId, { developmentId: id });
  }

  @Put('developments/:id/private')
  @Roles('admin', 'broker')
  putDevelopmentPrivate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.developments.upsertPrivate(user.tenantId, { developmentId: id }, toPrivate(parse(Private, body)));
  }
}
