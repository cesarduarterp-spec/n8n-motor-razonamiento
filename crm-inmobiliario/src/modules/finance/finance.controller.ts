import { BadRequestException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { type AuthUser, CurrentUser, Roles } from '../../common/auth/auth.js';
import { todayIn } from './dates.js';
import { BillingService } from './billing.service.js';

@Controller('finance')
export class FinanceController {
  constructor(private readonly billing: BillingService) {}

  /** Proyección de cobro de un contrato: GET /finance/contracts/:id/projection?inflation=2.5 */
  @Get('contracts/:id/projection')
  @Roles('admin', 'broker', 'back_office')
  async projection(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('inflation') inflation = '0',
  ) {
    const pct = Number(inflation);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new BadRequestException('inflation inválida');
    const result = await this.billing.projection(user.tenantId, id, pct);
    if (!result) throw new NotFoundException();
    return result;
  }

  @Get('due')
  @Roles('admin', 'broker', 'back_office')
  upcoming(@CurrentUser() user: AuthUser, @Query('from') from?: string) {
    return this.billing.upcomingDue(user.tenantId, from ?? todayIn());
  }
}
