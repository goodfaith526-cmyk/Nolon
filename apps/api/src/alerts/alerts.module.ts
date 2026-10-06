import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { CustomsModule } from '../customs/customs.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { TransportModule } from '../transport/transport.module.js';
import { WarehouseModule } from '../warehouse/warehouse.module.js';
import { AlertsController } from './alerts.controller.js';
import { AlertsService } from './alerts.service.js';

/** The five internal alerts (scope section 15), worked out by the modules that own the records. */
@Module({
  imports: [ShipmentsModule, BillingModule, CustomsModule, WarehouseModule, TransportModule],
  controllers: [AlertsController],
  providers: [AlertsService],
})
export class AlertsModule {}
