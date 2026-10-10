import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { DraftsModule } from '../drafts/drafts.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { GoodsReleaseDraftsController } from './goods-release-drafts.controller.js';
import { GoodsReleaseDraftsService } from './goods-release-drafts.service.js';
import { GrnDraftsController } from './grn-drafts.controller.js';
import { GrnDraftsService } from './grn-drafts.service.js';
import { ShipmentWarehouseController, WarehousesController } from './warehouse.controller.js';
import { WarehouseMovementsService } from './warehouse-movements.service.js';
import { WarehousesService } from './warehouses.service.js';
import { WarehouseReportsService } from './warehouse-reports.service.js';

@Module({
  imports: [ShipmentsModule, DocumentsModule, DraftsModule],
  controllers: [
    WarehousesController,
    ShipmentWarehouseController,
    GrnDraftsController,
    GoodsReleaseDraftsController,
  ],
  providers: [
    WarehouseReportsService,
    WarehousesService,
    WarehouseMovementsService,
    GrnDraftsService,
    GoodsReleaseDraftsService,
  ],
  exports: [WarehouseReportsService],
})
export class WarehouseModule {}
