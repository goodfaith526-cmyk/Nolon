import { Module } from '@nestjs/common';
import { BookingLifecycleModule } from '../bookings/booking-lifecycle.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { PublicTrackingController } from './public-tracking.controller.js';
import { PublicTrackingService } from './public-tracking.service.js';
import { ShipmentsController } from './shipments.controller.js';
import { ShipmentsService } from './shipments.service.js';
import { ShipmentReportsService } from './shipment-reports.service.js';

@Module({
  imports: [CustomersModule, MasterDataModule, BookingLifecycleModule],
  controllers: [ShipmentsController, PublicTrackingController],
  providers: [ShipmentReportsService, ShipmentsService, PublicTrackingService],
  exports: [ShipmentReportsService, ShipmentsService],
})
export class ShipmentsModule {}
