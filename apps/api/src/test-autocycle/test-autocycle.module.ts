import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CustomerServiceModule } from '../customer-service/customer-service.module.js';
import { WindowDeskModule } from '../window-desk/window-desk.module.js';
import { TestAutocycleService } from './test-autocycle.service.js';

/** Owner, 2026-11-07: the staging test autocycle (CS_TEST_AUTOCYCLE_ENABLED, staging only). */
@Module({
  imports: [AuthModule, CustomerServiceModule, WindowDeskModule],
  providers: [TestAutocycleService],
})
export class TestAutocycleModule {}
