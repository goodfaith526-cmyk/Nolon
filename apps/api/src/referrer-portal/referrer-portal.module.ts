import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { ReferrerPortalController } from './referrer-portal.controller.js';
import { ReferrerPortalService } from './referrer-portal.service.js';

@Module({
  imports: [AuditModule, CustomersModule],
  controllers: [ReferrerPortalController],
  providers: [ReferrerPortalService],
})
export class ReferrerPortalModule {}
