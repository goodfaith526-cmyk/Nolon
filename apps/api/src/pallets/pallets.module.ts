import { Module } from '@nestjs/common';
import { ConsolidationsModule } from '../consolidations/consolidations.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { TransportModule } from '../transport/transport.module.js';
import { WarehouseModule } from '../warehouse/warehouse.module.js';
import { PalletsController } from './pallets.controller.js';
import { PalletsService } from './pallets.service.js';

/** Plan 15-3: pallets that move what they carry. */
@Module({
  imports: [ShipmentsModule, ConsolidationsModule, TransportModule, WarehouseModule],
  controllers: [PalletsController],
  providers: [PalletsService],
})
export class PalletsModule {}
