import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { PAYMENT_INSTRUCTION_STATUSES, type PaymentInstructionDto } from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { currencyCode, parse, requiredText } from '../common/validation.js';
import { PaymentInstructionsService } from './payment-instructions.service.js';

const version = z.number().int().min(1);
const texts = { textAr: requiredText(2000), textEn: requiredText(2000) };
const listQuery = z
  .object({
    branchId: z.uuid().optional(),
    currency: currencyCode.optional(),
    status: z.enum(PAYMENT_INSTRUCTION_STATUSES).optional(),
  })
  .strict();
const createBody = z.object({ branchId: z.uuid(), currency: currencyCode, ...texts }).strict();
/** The branch and currency are fixed: a draft for another pair is a new draft. */
const updateBody = z.object({ version, ...texts }).strict();
const decisionBody = z.object({ version }).strict();

/**
 * Payment instructions per branch and currency (plan 04 section 4.1), for staff. Not readable by
 * the staff AI assistant (no @AgentReadable); the shipping bot reads only the approved one of an
 * approved request (GET /cs/booking-requests/:id).
 */
@Controller('payment-instructions')
export class PaymentInstructionsController {
  constructor(private readonly instructions: PaymentInstructionsService) {}

  @Get()
  @RequirePermission('payment_instructions:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<PaymentInstructionDto[]> {
    return this.instructions.list(user, parse(listQuery, query));
  }

  @Get(':id')
  @RequirePermission('payment_instructions:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PaymentInstructionDto> {
    return this.instructions.get(user, id);
  }

  @Post()
  @RequirePermission('payment_instructions:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<PaymentInstructionDto> {
    return this.instructions.create(user, parse(createBody, body));
  }

  @Patch(':id')
  @RequirePermission('payment_instructions:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PaymentInstructionDto> {
    return this.instructions.update(user, id, parse(updateBody, body));
  }

  @Post(':id/approve')
  @RequirePermission('payment_instructions:approve')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PaymentInstructionDto> {
    return this.instructions.approve(user, id, parse(decisionBody, body));
  }

  @Post(':id/retire')
  @RequirePermission('payment_instructions:cancel')
  retire(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PaymentInstructionDto> {
    return this.instructions.retire(user, id, parse(decisionBody, body));
  }
}
