import { Module } from '@nestjs/common';
import { PartnerRefsService } from './partner-refs.service.js';

/**
 * The partners other records name (sales outlet, consolidator, distributor). Its own module, with
 * no imports, so customers, quotations, bookings and shipments use it without a module cycle
 * (PartnersModule reaches them through payables).
 */
@Module({
  providers: [PartnerRefsService],
  exports: [PartnerRefsService],
})
export class PartnerRefsModule {}
