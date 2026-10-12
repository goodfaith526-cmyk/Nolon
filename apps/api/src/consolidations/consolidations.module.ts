import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import {
  ConsolidationsController,
  ShipmentConsolidationsController,
} from './consolidations.controller.js';
import { ConsolidationReportsService } from './consolidation-reports.service.js';
import { ConsolidationsService } from './consolidations.service.js';
import { ContainerCostsRegistry } from './container-costs.registry.js';

/** Consolidated (LCL) containers (annex B, consolidation). Payables posts their costs. */
@Module({
  imports: [BookingsModule, MasterDataModule, ShipmentsModule],
  controllers: [ConsolidationsController, ShipmentConsolidationsController],
  providers: [ConsolidationsService, ConsolidationReportsService, ContainerCostsRegistry],
  exports: [ConsolidationsService, ConsolidationReportsService, ContainerCostsRegistry],
})
export class ConsolidationsModule {}
