import { Module } from '@nestjs/common';
import { AssistantFormReviewsController } from './assistant-form-reviews.controller.js';
import { AssistantFormReviewsService } from './assistant-form-reviews.service.js';

/** "Review with the assistant": forms NOLON refused, kept briefly for the staff assistant. */
@Module({
  controllers: [AssistantFormReviewsController],
  providers: [AssistantFormReviewsService],
})
export class AssistantFormReviewsModule {}
