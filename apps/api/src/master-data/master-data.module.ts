import { Module } from '@nestjs/common';
import { MasterDataController } from './master-data.controller.js';
import { MasterDataService } from './master-data.service.js';

@Module({
  controllers: [MasterDataController],
  providers: [MasterDataService],
  exports: [MasterDataService],
})
export class MasterDataModule {}
