import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { DraftsModule } from '../drafts/drafts.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { UsersModule } from '../users/users.module.js';
import { FleetService } from './fleet.service.js';
import { PodService } from './pod.service.js';
import { TripCostsService } from './trip-costs.service.js';
import { TripDraftsController } from './trip-drafts.controller.js';
import { TripDraftsService } from './trip-drafts.service.js';
import {
  FleetController,
  ShipmentTransportController,
  TripsController,
} from './transport.controller.js';
import { TripsService } from './trips.service.js';
import { TripReportsService } from './trip-reports.service.js';

/** Inland transport (scope 12): fleet, trips, trip costs and proof of delivery. */
@Module({
  imports: [
    AccountingModule,
    CurrenciesModule,
    DocumentsModule,
    DraftsModule,
    MasterDataModule,
    ShipmentsModule,
    UsersModule,
  ],
  controllers: [
    FleetController,
    TripsController,
    ShipmentTransportController,
    TripDraftsController,
  ],
  providers: [
    TripReportsService,
    FleetService,
    TripsService,
    TripCostsService,
    PodService,
    TripDraftsService,
  ],
  exports: [TripReportsService, TripsService, TripCostsService, FleetService],
})
export class TransportModule {}
