import { Controller, Get } from '@nestjs/common';
import type { DashboardDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/decorators.js';
import { DashboardService } from './dashboard.service.js';

/** Any signed-in user; the service leaves out the modules they may not view. */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  summary(@CurrentUser() user: AuthUser): Promise<DashboardDto> {
    return this.dashboard.summary(user);
  }
}
