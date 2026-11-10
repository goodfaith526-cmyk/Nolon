import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ReferrerChannelsService } from './referrer-channels.service.js';

/**
 * Plan 18, 5 and 6: a referral broker's chat account and the notices to it. Its own module, so the
 * partner screen, the Customer Service API and the commission sync use it without a module cycle.
 */
@Module({
  imports: [AuditModule],
  providers: [ReferrerChannelsService],
  exports: [ReferrerChannelsService],
})
export class ReferrerChannelsModule {}
