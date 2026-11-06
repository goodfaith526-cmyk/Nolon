import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service.js';

/** Server-side PDF rendering (plan 14-3), shared by the statement and later the waybill. */
@Module({ providers: [PdfService], exports: [PdfService] })
export class PdfModule {}
