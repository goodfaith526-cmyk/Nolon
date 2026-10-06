import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ALERT_KINDS, ALERT_MAX_DAYS, type AlertSettingDto, type AlertsDto } from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { parse } from '../common/validation.js';
import { AlertsService } from './alerts.service.js';

const kindParam = z.enum(ALERT_KINDS);
const settingBody = z.object({ days: z.int().min(0).max(ALERT_MAX_DAYS) }).strict();

/** Internal alerts (scope section 15) and how many days each waits. */
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  /** Every signed-in user: the alerts of the records they may see (none when there are none). */
  @Get()
  list(@CurrentUser() user: AuthUser): Promise<AlertsDto> {
    return this.alerts.forUser(user);
  }

  @Get('settings')
  @RequirePermission('alert_settings:view')
  settings(): Promise<AlertSettingDto[]> {
    return this.alerts.settings();
  }

  @Put('settings/:kind')
  @RequirePermission('alert_settings:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('kind') kind: string,
    @Body() body: unknown,
  ): Promise<AlertSettingDto[]> {
    return this.alerts.updateSetting(user, parse(kindParam, kind), parse(settingBody, body).days);
  }
}
