import { Module } from '@nestjs/common';
import { ImportRecordsRegistry } from './import-records.registry.js';

@Module({
  providers: [ImportRecordsRegistry],
  exports: [ImportRecordsRegistry],
})
export class ImportsModule {}
