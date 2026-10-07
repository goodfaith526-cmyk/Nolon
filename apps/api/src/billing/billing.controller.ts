import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CREDIT_NOTE_STATUSES,
  INVOICE_STATUSES,
  RECEIPT_STATUSES,
  type CreditNoteDto,
  type CreditNoteSummaryDto,
  type CustomerInvoiceDto,
  type CustomerInvoiceSummaryDto,
  type CustomerStatementDto,
  type Page,
  type ReceiptDto,
  type ReceiptSummaryDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { AgentReadable, CurrentUser, RequirePermission } from '../auth/decorators.js';
import {
  amount,
  currencyCode,
  dateString,
  fxRate,
  optionalText,
  pageQuery,
  parse,
  quantity,
  requiredText,
} from '../common/validation.js';
import { CustomerStatementService } from './customer-statement.service.js';
import { CreditNotesService } from './credit-notes.service.js';
import { InvoicesService } from './invoices.service.js';
import { ReceiptsService } from './receipts.service.js';

const invoiceLine = z
  .object({
    chargeTypeCode: z.string().trim().toUpperCase().min(1).max(20),
    description: optionalText(500),
    quantity,
    unitPrice: amount,
  })
  .strict();
const createInvoiceBody = z.object({ shipmentId: z.uuid() }).strict();
const updateInvoiceBody = z
  .object({
    currency: currencyCode,
    fxRate: fxRate.nullish(),
    invoiceDate: dateString,
    dueDate: dateString,
    notes: optionalText(2000),
    lines: z.array(invoiceLine).min(1).max(100),
  })
  .strict();
const reasonBody = z.object({ reason: requiredText(1000) }).strict();
const invoiceListQuery = pageQuery.extend({
  status: z.enum(INVOICE_STATUSES).optional(),
  customerId: z.uuid().optional(),
  shipmentId: z.uuid().optional(),
  openOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

const createReceiptBody = z
  .object({
    customerId: z.uuid(),
    receiptDate: dateString,
    currency: currencyCode,
    fxRate: fxRate.nullish(),
    amount,
    cashAccountId: z.uuid(),
    reference: optionalText(100),
    notes: optionalText(2000),
    allocations: z.array(z.object({ invoiceId: z.uuid(), amount }).strict()).max(100),
  })
  .strict();
const statementQuery = z
  .object({ from: dateString, to: dateString, branchId: z.uuid().optional() })
  .strict();
const creditNoteFields = {
  creditDate: dateString,
  amount,
  reason: requiredText(1000),
};
const createCreditNoteBody = z
  .object({ requestId: z.uuid(), invoiceId: z.uuid(), ...creditNoteFields })
  .strict();
const updateCreditNoteBody = z.object(creditNoteFields).strict();
const creditNoteListQuery = pageQuery.extend({
  status: z.enum(CREDIT_NOTE_STATUSES).optional(),
  invoiceId: z.uuid().optional(),
  customerId: z.uuid().optional(),
});
const openingItemBody = z
  .object({
    requestId: z.uuid(),
    customerId: z.uuid(),
    entryDate: dateString,
    reference: requiredText(50),
    invoiceDate: dateString,
    dueDate: dateString,
    currency: currencyCode,
    fxRate: fxRate.nullish(),
    amount,
  })
  .strict();

const receiptListQuery = pageQuery.extend({
  status: z.enum(RECEIPT_STATUSES).optional(),
  customerId: z.uuid().optional(),
});

@Controller('customer-invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @AgentReadable()
  @Get()
  @RequirePermission('customer_invoices:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<Page<CustomerInvoiceSummaryDto>> {
    return this.invoices.list(user, parse(invoiceListQuery, query));
  }

  @AgentReadable()
  @Get(':id')
  @RequirePermission('customer_invoices:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerInvoiceDto> {
    return this.invoices.get(user, id);
  }

  @Post()
  @RequirePermission('customer_invoices:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<CustomerInvoiceDto> {
    return this.invoices.createForShipment(user, parse(createInvoiceBody, body).shipmentId);
  }

  /** A customer's open invoice at go-live (annex C rule 15), approved and posted at once. */
  @Post('opening')
  @RequirePermission('customer_invoices:view', 'manual_journals:create', 'manual_journals:approve')
  createOpeningItem(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<CustomerInvoiceDto> {
    return this.invoices.createOpeningItem(user, parse(openingItemBody, body));
  }

  @Patch(':id')
  @RequirePermission('customer_invoices:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CustomerInvoiceDto> {
    return this.invoices.update(user, id, parse(updateInvoiceBody, body));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customer_invoices:approve')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerInvoiceDto> {
    return this.invoices.approve(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customer_invoices:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CustomerInvoiceDto> {
    return this.invoices.cancel(user, id, parse(reasonBody, body).reason);
  }
}

@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @AgentReadable()
  @Get()
  @RequirePermission('receipts:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<Page<ReceiptSummaryDto>> {
    return this.receipts.list(user, parse(receiptListQuery, query));
  }

  @AgentReadable()
  @Get(':id')
  @RequirePermission('receipts:view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<ReceiptDto> {
    return this.receipts.get(user, id);
  }

  @Post()
  @RequirePermission('receipts:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<ReceiptDto> {
    return this.receipts.create(user, parse(createReceiptBody, body));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('receipts:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ReceiptDto> {
    return this.receipts.cancel(user, id, parse(reasonBody, body).reason);
  }
}

@Controller('customer-statements')
export class CustomerStatementsController {
  constructor(private readonly statements: CustomerStatementService) {}

  /** Statement of account: the customer's invoices and receipts (it shows both). */
  @AgentReadable()
  @Get(':customerId')
  @RequirePermission('customer_invoices:view', 'receipts:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: unknown,
  ): Promise<CustomerStatementDto> {
    return this.statements.statement(user, { customerId, ...parse(statementQuery, query) });
  }
}

@Controller('credit-notes')
export class CreditNotesController {
  constructor(private readonly creditNotes: CreditNotesService) {}

  @AgentReadable()
  @Get()
  @RequirePermission('credit_notes:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<Page<CreditNoteSummaryDto>> {
    return this.creditNotes.list(user, parse(creditNoteListQuery, query));
  }

  @AgentReadable()
  @Get(':id')
  @RequirePermission('credit_notes:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CreditNoteDto> {
    return this.creditNotes.get(user, id);
  }

  @Post()
  @RequirePermission('credit_notes:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<CreditNoteDto> {
    return this.creditNotes.create(user, parse(createCreditNoteBody, body));
  }

  @Patch(':id')
  @RequirePermission('credit_notes:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CreditNoteDto> {
    return this.creditNotes.update(user, id, parse(updateCreditNoteBody, body));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('credit_notes:approve')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CreditNoteDto> {
    return this.creditNotes.approve(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('credit_notes:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CreditNoteDto> {
    return this.creditNotes.cancel(user, id, parse(reasonBody, body).reason);
  }
}
