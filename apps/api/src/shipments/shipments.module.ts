import { Module } from '@nestjs/common';
import { BookingLifecycleModule } from '../bookings/booking-lifecycle.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { DraftsModule } from '../drafts/drafts.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { PartnerRefsModule } from '../partners/partner-refs.module.js';
import { PublicTrackingController } from './public-tracking.controller.js';
import { PublicTrackingService } from './public-tracking.service.js';
import { ShipmentsController } from './shipments.controller.js';
import { ShipmentInvoicesRegistry } from './shipment-invoices.registry.js';
import { ShipmentLinksRegistry } from './shipment-links.registry.js';
import { ShipmentStockRegistry } from './shipment-stock.registry.js';
import { ShipmentsService } from './shipments.service.js';
import { ShipmentReportsService } from './shipment-reports.service.js';
import { ShipmentStatusDraftsController } from './shipment-status-drafts.controller.js';
import { ShipmentStatusDraftsService } from './shipment-status-drafts.service.js';

@Module({
  imports: [
    CustomersModule,
    MasterDataModule,
    BookingLifecycleModule,
    DraftsModule,
    PartnerRefsModule,
  ],
  controllers: [ShipmentsController, PublicTrackingController, ShipmentStatusDraftsController],
  providers: [
    ShipmentInvoicesRegistry,
    ShipmentLinksRegistry,
    ShipmentStockRegistry,
    ShipmentReportsService,
    ShipmentsService,
    PublicTrackingService,
    ShipmentStatusDraftsService,
  ],
  exports: [
    ShipmentInvoicesRegistry,
    ShipmentLinksRegistry,
    ShipmentStockRegistry,
    ShipmentReportsService,
    ShipmentsService,
    ShipmentStatusDraftsService,
  ],
})
export class ShipmentsModule {}
