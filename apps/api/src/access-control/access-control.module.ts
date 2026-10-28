import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AccessControlController, BranchAccessController } from './access-control.controller.js';
import { AccessControlService } from './access-control.service.js';

@Module({
  imports: [AuditModule],
  controllers: [AccessControlController, BranchAccessController],
  providers: [AccessControlService],
})
export class AccessControlModule {}
