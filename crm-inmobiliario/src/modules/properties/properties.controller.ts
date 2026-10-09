import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { type AuthUser, CurrentUser, Roles } from '../../common/auth/auth.js';
import { PropertiesService } from './properties.service.js';

const CreateProperty = z.object({
  code: z.string().min(1),
  title: z.string().min(3),
  description: z.string().optional(),
  operation: z.enum(['sale', 'rent', 'temporary_rent']),
  status: z.enum(['draft', 'available', 'reserved', 'rented', 'sold', 'paused']).default('available'),
  propertyType: z.string(),
  address: z.string().optional(),
  neighborhood: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
  price: z.number().positive().optional(),
  currency: z.enum(['ARS', 'USD']).default('ARS'),
  expenses: z.number().nonnegative().optional(),
  rooms: z.number().int().optional(),
  bedrooms: z.number().int().optional(),
  bathrooms: z.number().int().optional(),
  coveredM2: z.number().optional(),
  totalM2: z.number().optional(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  showExactAddress: z.boolean().default(false),
  media: z
    .array(
      z.object({
        type: z.enum(['photo', 'video', 'tour360', 'floorplan']),
        url: z.string().url().startsWith('https://'),
        provider: z.enum(['youtube', 'matterport', 'kuula', 'other']).optional(),
        caption: z.string().optional(),
      }),
    )
    .default([]),
});

@Controller('properties')
export class PropertiesController {
  constructor(private readonly properties: PropertiesService) {}

  @Post()
  @Roles('admin', 'broker', 'sales_agent')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const parsed = CreateProperty.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    return this.properties.create(user.tenantId, {
      ...p,
      price: p.price?.toFixed(2),
      expenses: p.expenses?.toFixed(2),
      coveredM2: p.coveredM2?.toFixed(2),
      totalM2: p.totalM2?.toFixed(2),
      latitude: p.latitude?.toFixed(6),
      longitude: p.longitude?.toFixed(6),
    });
  }

  /** Listado de la cartera (capa pública) para el panel. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('operation') operation?: string, @Query('status') status?: string) {
    return this.properties.list(user.tenantId, { operation, status });
  }

  /** GET /properties/search?q=depto 2 ambientes con balcón cerca del subte&operation=rent&maxPrice=600000 */
  @Get('search')
  search(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
    @Query('operation') operation?: 'sale' | 'rent' | 'temporary_rent',
    @Query('maxPrice') maxPrice?: string,
    @Query('neighborhood') neighborhood?: string,
  ) {
    return this.properties.search(user.tenantId, {
      query: q,
      operation,
      neighborhood,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
      limit: 10,
    });
  }
}
