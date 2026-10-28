import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import type { FormReviewDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { AgentReadable, CurrentUser } from '../auth/decorators.js';
import { parse } from '../common/validation.js';
import { AssistantFormReviewsService } from './assistant-form-reviews.service.js';
import { createFormReviewBody, formReviewPermissions } from './form-review-rules.js';

/** "Review with the assistant": a refused form, kept for the staff assistant to read. */
@Controller('assistant-form-reviews')
export class AssistantFormReviewsController {
  constructor(private readonly reviews: AssistantFormReviewsService) {}

  /** From NOLON's own screens only (the assistant may not POST here). */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<FormReviewDto> {
    const parsed = parse(createFormReviewBody, body);
    const needed = formReviewPermissions(parsed.form, parsed.mode);
    // Every permission the form needs, in one branch of theirs (plan 03: held per branch).
    if (needed.length === 0 || user.access.branchesWith(needed).length === 0) {
      throw new ForbiddenException('Not allowed to save this form');
    }
    return this.reviews.create(user, parsed);
  }

  /** Its author only, while it lasts; the assistant reads it with their delegated token. */
  @AgentReadable()
  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FormReviewDto> {
    return this.reviews.get(user, id);
  }
}
