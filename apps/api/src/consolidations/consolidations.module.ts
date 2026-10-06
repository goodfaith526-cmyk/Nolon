import { Module } from '@nestjs/common';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import {
  ConsolidationsController,
  ShipmentConsolidationsController,
} from './consolidations.controller.js';
import { ConsolidationsService } from './consolidations.service.js';
import { ContainerCostsRegistry } from './container-costs.registry.js';

/** Consolidated (LCL) containers (annex B, consolidation). Payables posts their costs. */
@Module({
  imports: [MasterDataModule, ShipmentsModule],
  controllers: [ConsolidationsController, ShipmentConsolidationsController],
  providers: [ConsolidationsService, ContainerCostsRegistry],
  exports: [ConsolidationsService, ContainerCostsRegistry],
})
export class ConsolidationsModule {}
