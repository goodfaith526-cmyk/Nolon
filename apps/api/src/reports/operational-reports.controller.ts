import { Controller, Get, Query, Res, type StreamableFile } from '@nestjs/common';
import {
  AUDIT_ENTITIES,
  CUSTOMS_STATUSES,
  LOCALES,
  SHIPMENT_STATUSES,
  SHIPPING_MODES,
  TRIP_KINDS,
  WAREHOUSE_MOVEMENT_KINDS,
  type AuditLogDto,
  type CustomerActivityDto,
  type CustomsFilesDto,
  type LateShipmentsDto,
  type SalesConversionDto,
  type ShipmentsReportDto,
  type TripsReportDto,
  type WarehouseMovementsDto,
  type WarehouseOnHandDto,
} from '@nolon/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { AgentReadable, CurrentUser, RequirePermission } from '../auth/decorators.js';
import { dateString, parse } from '../common/validation.js';
import { xlsxDownload } from './excel-response.js';
import {
  type OperationalReportRequest,
  OperationalReportsService,
} from './operational-reports.service.js';

/** A period runs from `from` to `to`, both included; from is not after to. */
const period = z.object({ from: dateString, to: dateString, branchId: z.uuid().optional() });
const ordered = <T extends { from: string; to: string }>(schema: z.ZodType<T>) =>
  schema.refine((q) => q.from <= q.to, { message: 'from is after to', path: ['to'] });

const customerPeriod = ordered(period.extend({ customerId: z.uuid().optional() }));
const shipmentsQuery = ordered(
  period.extend({
    customerId: z.uuid().optional(),
    mode: z.enum(SHIPPING_MODES).optional(),
    status: z.enum(SHIPMENT_STATUSES).optional(),
  }),
);
const onHandQuery = z.object({ branchId: z.uuid().optional(), warehouseId: z.uuid().optional() });
const movementsQuery = ordered(
  period.extend({
    warehouseId: z.uuid().optional(),
    kind: z.enum(WAREHOUSE_MOVEMENT_KINDS).optional(),
  }),
);
const customsQuery = ordered(period.extend({ status: z.enum(CUSTOMS_STATUSES).optional() }));
const tripsQuery = ordered(
  period.extend({
    kind: z.enum(TRIP_KINDS).optional(),
    vehicleId: z.uuid().optional(),
    driverId: z.uuid().optional(),
    carrierId: z.uuid().optional(),
  }),
);
const auditQuery = ordered(
  period.extend({ userId: z.uuid().optional(), entity: z.enum(AUDIT_ENTITIES).optional() }),
);
const exportQuery = z.object({ locale: z.enum(LOCALES).optional() });

/**
 * Operational reports (annex D section 3), each as JSON and as an Excel download (`/export`,
 * headers in `locale`, else the user's language). Each needs operational_reports:view and the view
 * permission of the module that owns its records (so a warehouse user does not read customs files,
 * nor a customs user trips); the audit log needs audit_log:view. Customer activity carries
 * revenue only for financial_reports:view. Branches come from the user (branch-scope.ts).
 */
@Controller('reports')
export class OperationalReportsController {
  constructor(private readonly reports: OperationalReportsService) {}

  @AgentReadable()
  @Get('shipments')
  @RequirePermission('operational_reports:view', 'shipments:view')
  shipments(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<ShipmentsReportDto> {
    return this.reports.shipmentsByStatus(user, parse(shipmentsQuery, query));
  }

  @Get('shipments/export')
  @RequirePermission('operational_reports:view', 'shipments:view')
  exportShipments(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'shipments',
      query: parse(shipmentsQuery, query),
    });
  }

  @AgentReadable()
  @Get('late-shipments')
  @RequirePermission('operational_reports:view', 'shipments:view')
  lateShipments(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<LateShipmentsDto> {
    return this.reports.lateShipments(user, parse(customerPeriod, query));
  }

  @Get('late-shipments/export')
  @RequirePermission('operational_reports:view', 'shipments:view')
  exportLateShipments(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'late-shipments',
      query: parse(customerPeriod, query),
    });
  }

  @Get('sales-conversion')
  @RequirePermission('operational_reports:view', 'quotations:view', 'bookings:view')
  salesConversion(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<SalesConversionDto> {
    return this.reports.salesConversion(user, parse(customerPeriod, query));
  }

  @Get('sales-conversion/export')
  @RequirePermission('operational_reports:view', 'quotations:view', 'bookings:view')
  exportSalesConversion(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'sales-conversion',
      query: parse(customerPeriod, query),
    });
  }

  @AgentReadable()
  @Get('customer-activity')
  @RequirePermission('operational_reports:view', 'shipments:view', 'customers:view')
  customerActivity(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<CustomerActivityDto> {
    return this.reports.customerActivity(user, parse(customerPeriod, query));
  }

  @Get('customer-activity/export')
  @RequirePermission('operational_reports:view', 'shipments:view', 'customers:view')
  exportCustomerActivity(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'customer-activity',
      query: parse(customerPeriod, query),
    });
  }

  @AgentReadable()
  @Get('warehouse-on-hand')
  @RequirePermission('operational_reports:view', 'warehouse:view')
  warehouseOnHand(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<WarehouseOnHandDto> {
    return this.reports.warehouseOnHand(user, parse(onHandQuery, query));
  }

  @Get('warehouse-on-hand/export')
  @RequirePermission('operational_reports:view', 'warehouse:view')
  exportWarehouseOnHand(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'warehouse-on-hand',
      query: parse(onHandQuery, query),
    });
  }

  @Get('warehouse-movements')
  @RequirePermission('operational_reports:view', 'warehouse:view')
  warehouseMovements(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<WarehouseMovementsDto> {
    return this.reports.warehouseMovements(user, parse(movementsQuery, query));
  }

  @Get('warehouse-movements/export')
  @RequirePermission('operational_reports:view', 'warehouse:view')
  exportWarehouseMovements(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'warehouse-movements',
      query: parse(movementsQuery, query),
    });
  }

  @Get('customs-files')
  @RequirePermission('operational_reports:view', 'customs:view')
  customsFiles(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<CustomsFilesDto> {
    return this.reports.customsFiles(user, parse(customsQuery, query));
  }

  @Get('customs-files/export')
  @RequirePermission('operational_reports:view', 'customs:view')
  exportCustomsFiles(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'customs-files',
      query: parse(customsQuery, query),
    });
  }

  @Get('trips')
  @RequirePermission('operational_reports:view', 'transport_trips:view')
  trips(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<TripsReportDto> {
    return this.reports.tripsReport(user, parse(tripsQuery, query));
  }

  @Get('trips/export')
  @RequirePermission('operational_reports:view', 'transport_trips:view')
  exportTrips(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, { report: 'trips', query: parse(tripsQuery, query) });
  }

  @Get('audit-log')
  @RequirePermission('audit_log:view')
  auditLog(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<AuditLogDto> {
    return this.reports.auditLog(user, parse(auditQuery, query));
  }

  @Get('audit-log/export')
  @RequirePermission('audit_log:view')
  exportAuditLog(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.download(user, query, res, {
      report: 'audit-log',
      query: parse(auditQuery, query),
    });
  }

  private async download(
    user: AuthUser,
    query: unknown,
    res: Response,
    request: OperationalReportRequest,
  ): Promise<StreamableFile> {
    const { locale } = parse(exportQuery, query);
    return xlsxDownload(res, await this.reports.export(user, request, locale));
  }
}
