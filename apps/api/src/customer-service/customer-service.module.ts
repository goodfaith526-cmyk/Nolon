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
import { BookingRequestGuard } from './booking-request.guard.js';
import { BookingReviewController, RejectReasonsController } from './booking-review.controller.js';
import { BookingReviewService } from './booking-review.service.js';
import { BookingRequestsService } from './booking-requests.service.js';
import { CatalogService } from './catalog.service.js';
import { ApiClientGuard } from './api-client.guard.js';
import { ApiClientsService } from './api-clients.service.js';
import { CustomerMeService } from './customer-me.service.js';
import {
  ApiClientsController,
  BookingRequestsController,
  CatalogController,
  CustomerMeController,
  CustomerServiceController,
  CustomerTokensController,
  QuoteController,
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
    AuditModule,
    BookingsModule,
    CurrenciesModule,
    MasterDataModule,
    RatesModule,
  ],
  controllers: [
    CustomerProfileReviewController,
    CustomerIdentityController,
    CustomerServiceController,
    CustomerTokensController,
    CatalogController,
    QuoteController,
    BookingRequestsController,
    CustomerMeController,
    ApiClientsController,
    BookingReviewController,
    RejectReasonsController,
    PaymentInstructionsController,
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
    CatalogService,
    QuoteService,
    BookingRequestGuard,
    BookingRequestsService,
    BookingReviewService,
    PaymentInstructionsService,
  ],
})
export class CustomerServiceModule {}
