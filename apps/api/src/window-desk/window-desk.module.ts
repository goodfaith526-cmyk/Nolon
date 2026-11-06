import { Module } from '@nestjs/common';
import { WarehouseModule } from '../warehouse/warehouse.module.js';
import { WindowDeskController } from './window-desk.controller.js';
import { WindowDeskService } from './window-desk.service.js';

/** Plan 13 sections 2 and 2a: the window desk, the only entry point for a window's work. */
@Module({
  imports: [WarehouseModule],
  controllers: [WindowDeskController],
  providers: [WindowDeskService],
})
export class WindowDeskModule {}
