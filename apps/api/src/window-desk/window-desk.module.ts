import { Module } from '@nestjs/common';
import { WindowDeskController } from './window-desk.controller.js';
import { WindowDeskService } from './window-desk.service.js';

/** Plan 13 sections 2 and 2a: the window desk, the only entry point for a window's work. */
@Module({
  controllers: [WindowDeskController],
  providers: [WindowDeskService],
})
export class WindowDeskModule {}
