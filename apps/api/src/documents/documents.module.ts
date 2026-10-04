import { Module } from '@nestjs/common';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { DocumentReportsService } from './document-reports.service.js';

@Module({
  imports: [ShipmentsModule, MasterDataModule],
  controllers: [DocumentsController],
  providers: [DocumentReportsService, DocumentsService],
  exports: [DocumentReportsService, DocumentsService],
})
export class DocumentsModule {}
