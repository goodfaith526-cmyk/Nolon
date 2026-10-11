import { Module } from '@nestjs/common';
import { DraftRetentionService } from './draft-retention.service.js';
import { DraftsService } from './drafts.service.js';

/**
 * The rules every entry draft type shares; each type's module imports this. The retention purge
 * of all draft types lives here too.
 */
@Module({
  providers: [DraftsService, DraftRetentionService],
  exports: [DraftsService, DraftRetentionService],
})
export class DraftsModule {}
