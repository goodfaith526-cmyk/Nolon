import { Controller, Get } from '@nestjs/common';
import type { WarehouseStockDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { OperationalReportsService } from './operational-reports.service.js';

/**
 * The warehouse screen's stock: what each warehouse holds now and the shipments waiting for a
 * goods receipt. Needs warehouse:view only (the warehouse team's own screen, not a report);
 * shipments are scoped to the user's branches and outlets like everywhere else.
 */
@Controller('warehouses')
export class WarehouseStockController {
  constructor(private readonly reports: OperationalReportsService) {}

  @Get('stock')
  @RequirePermission('warehouse:view')
  stock(@CurrentUser() user: AuthUser): Promise<WarehouseStockDto> {
    return this.reports.warehouseStock(user);
  }
}
