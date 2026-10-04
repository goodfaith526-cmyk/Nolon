import { Module } from '@nestjs/common';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

@Module({
  imports: [ShipmentsModule, MasterDataModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
