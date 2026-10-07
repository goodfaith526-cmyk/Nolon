import { Controller, Get, Query } from '@nestjs/common';
import type { BranchDashboardDto, DashboardDto, ManagementDashboardDto } from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission, AgentReadable } from '../auth/decorators.js';
import { dateString, parse } from '../common/validation.js';
import { DashboardFiguresService } from './dashboard-figures.service.js';
import { DashboardService } from './dashboard.service.js';

const dashboardQuery = z
  .strictObject({
    from: dateString.optional(),
    to: dateString.optional(),
    branchId: z.uuid().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'from is after to',
    path: ['to'],
  });

/**
 * GET /dashboard: any signed-in user; the service leaves out the modules they may not view.
 * GET /dashboard/management and /dashboard/branch (annex D section 2): dashboards:view.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly figures: DashboardFiguresService,
  ) {}

  @AgentReadable()
  @Get()
  summary(@CurrentUser() user: AuthUser): Promise<DashboardDto> {
    return this.dashboard.summary(user);
  }

  @AgentReadable()
  @Get('management')
  @RequirePermission('dashboards:view')
  management(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<ManagementDashboardDto> {
    return this.figures.management(user, parse(dashboardQuery, query));
  }

  @AgentReadable()
  @Get('branch')
  @RequirePermission('dashboards:view')
  branch(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<BranchDashboardDto> {
    return this.figures.branch(user, parse(dashboardQuery, query));
  }
}
