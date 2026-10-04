import { Module } from '@nestjs/common';
import { BookingLifecycleService } from './booking-lifecycle.service.js';

@Module({
  providers: [BookingLifecycleService],
  exports: [BookingLifecycleService],
})
export class BookingLifecycleModule {}
