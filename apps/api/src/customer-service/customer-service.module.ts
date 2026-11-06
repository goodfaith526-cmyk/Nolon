import { CustomerStagesController } from './customer-stages.controller.js';
import { CustomerStagesService } from './customer-stages.service.js';
import { CustomerProfileReviewController } from './customer-profile-review.controller.js';
import { CustomerProfileReviewService } from './customer-profile-review.service.js';
import { CustomersModule } from '../customers/customers.module.js';
import { CustomerIdentityController } from './customer-identity.controller.js';
import { CustomerIdentityAuth } from './customer-identity-auth.js';
import { CustomerIdentityService } from './customer-identity.service.js';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { CsDocumentsService } from './cs-documents.service.js';
import { CsEventsService } from './cs-events.service.js';
import { CS_NOTICE_TRANSPORT, CsOutboxWorker } from './cs-outbox.worker.js';
import { CsWebhooksService } from './cs-webhooks.service.js';
import { httpsTransport } from './webhook-delivery.js';
import { BookingRequestGuard } from './booking-request.guard.js';
import { BookingReviewController, RejectReasonsController } from './booking-review.controller.js';
import { BookingReviewService } from './booking-review.service.js';
import { BookingRequestReportsService } from './booking-request-reports.service.js';
import { BookingRequestsService } from './booking-requests.service.js';
import { BotQuotationsService } from './bot-quotations.service.js';
import { QuotationsModule } from '../quotations/quotations.module.js';
import { CatalogService } from './catalog.service.js';
import { ApiClientGuard } from './api-client.guard.js';
import { ApiClientsService } from './api-clients.service.js';
import { CustomerMeService } from './customer-me.service.js';
import { CustomerStatementService } from './customer-statement.service.js';
import { PdfModule } from '../pdf/pdf.module.js';
import {
  ApiClientsController,
  BookingRequestsController,
  CsDocumentsController,
  CatalogController,
  CustomerMeController,
  CustomerServiceController,
  CustomerTokensController,
  QuotationSaveController,
  QuoteController,
  QuotesController,
} from './customer-service.controller.js';
import { CustomerServiceService } from './customer-service.service.js';
import { CustomerTokenGuard } from './customer-token.guard.js';
import { CustomerTokensService } from './customer-tokens.service.js';
import { PaymentInstructionsController } from './payment-instructions.controller.js';
import { PaymentInstructionsService } from './payment-instructions.service.js';
import { QuoteService } from './quote.service.js';

/** The Customer Service API and its keys (scope section 17). */
@Module({
  imports: [
    CustomersModule,
    PdfModule,
    AuditModule,
    BookingsModule,
    CurrenciesModule,
    MasterDataModule,
    QuotationsModule,
    RatesModule,
    ShipmentsModule,
  ],
  controllers: [
    CustomerProfileReviewController,
    CustomerIdentityController,
    CustomerServiceController,
    CustomerTokensController,
    CatalogController,
    QuoteController,
    QuotesController,
    BookingRequestsController,
    QuotationSaveController,
    CustomerMeController,
    ApiClientsController,
    BookingReviewController,
    RejectReasonsController,
    PaymentInstructionsController,
    CustomerStagesController,
    CsDocumentsController,
  ],
  providers: [
    CustomerProfileReviewService,
    CustomerIdentityAuth,
    CustomerIdentityService,
    ApiClientGuard,
    ApiClientsService,
    CustomerServiceService,
    CustomerTokensService,
    CustomerTokenGuard,
    CustomerMeService,
    CustomerStatementService,
    CatalogService,
    QuoteService,
    BookingRequestGuard,
    BookingRequestsService,
    BotQuotationsService,
    BookingReviewService,
    PaymentInstructionsService,
    CustomerStagesService,
    CsEventsService,
    CsDocumentsService,
    CsWebhooksService,
    CsOutboxWorker,
    { provide: CS_NOTICE_TRANSPORT, useFactory: () => httpsTransport() },
    BookingRequestReportsService,
  ],
  exports: [ApiClientGuard, BookingRequestReportsService],
})
export class CustomerServiceModule {}
