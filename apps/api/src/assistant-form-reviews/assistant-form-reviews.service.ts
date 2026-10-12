import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  FORM_REVIEW_TTL_MINUTES,
  type FormReviewDto,
  type FormReviewForm,
  type FormReviewMode,
} from '@nolon/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { createFormReviewBody } from './form-review-rules.js';

type Row = Prisma.AssistantFormReviewGetPayload<object>;

function toDto(row: Row): FormReviewDto {
  return {
    id: row.id,
    form: row.form as FormReviewForm,
    mode: row.mode as FormReviewMode,
    values: row.values as Record<string, unknown>,
    invalidFields: row.invalidFields,
    reason: row.reason,
    customerName: row.customerName,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * Forms NOLON refused to save, kept for the staff assistant ("Review with the assistant"). A
 * kept form is its author's own input: only they read it (in NOLON or through the assistant with
 * their delegated token), and only until it expires. It is not branch data, creates nothing, and
 * is never draft evidence; the retention purge removes it once expired.
 */
@Injectable()
export class AssistantFormReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async create(
    user: AuthUser,
    body: z.output<typeof createFormReviewBody>,
  ): Promise<FormReviewDto> {
    // Without an assistant there is nothing to open it with.
    if (!this.env.AGENT_ASSISTANT_URL) throw new NotFoundException('No assistant');
    const now = new Date();
    const row = await this.prisma.assistantFormReview.create({
      data: {
        userId: user.id,
        form: body.form,
        mode: body.mode,
        values: body.values as Prisma.InputJsonObject,
        invalidFields: body.invalidFields,
        reason: body.reason,
        customerName: body.customerName,
        createdAt: now,
        expiresAt: new Date(now.getTime() + FORM_REVIEW_TTL_MINUTES * 60_000),
      },
    });
    return toDto(row);
  }

  /** The user's own kept form while it lasts; anyone else's, or an expired one, is not found. */
  async get(user: AuthUser, id: string): Promise<FormReviewDto> {
    const row = await this.prisma.assistantFormReview.findFirst({
      where: { id, userId: user.id, expiresAt: { gt: new Date() } },
    });
    if (!row) throw new NotFoundException('Form not found');
    return toDto(row);
  }
}
