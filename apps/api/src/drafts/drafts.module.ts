import { Module } from '@nestjs/common';
import { DraftsService } from './drafts.service.js';

/** The rules every entry draft type shares; each type's module imports this. */
@Module({
  providers: [DraftsService],
  exports: [DraftsService],
})
export class DraftsModule {}
