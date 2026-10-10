import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { GrnDraftsController } from './grn-drafts.controller.js';
import { GrnDraftsService } from './grn-drafts.service.js';
import { ShipmentWarehouseController, WarehousesController } from './warehouse.controller.js';
import { WarehouseMovementsService } from './warehouse-movements.service.js';
import { WarehousesService } from './warehouses.service.js';
import { WarehouseReportsService } from './warehouse-reports.service.js';

@Module({
  imports: [ShipmentsModule, DocumentsModule],
  controllers: [WarehousesController, ShipmentWarehouseController, GrnDraftsController],
  providers: [
    WarehouseReportsService,
    WarehousesService,
    WarehouseMovementsService,
    GrnDraftsService,
  ],
  exports: [WarehouseReportsService],
})
export class WarehouseModule {}
