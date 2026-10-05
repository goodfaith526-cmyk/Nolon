import { Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** The audit log of rates, customers and user accounts (see AuditService). */
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
