import { Module } from '@nestjs/common';
import { ApiClientGuard } from './api-client.guard.js';
import { ApiClientsService } from './api-clients.service.js';
import { ApiClientsController, CustomerServiceController } from './customer-service.controller.js';
import { CustomerServiceService } from './customer-service.service.js';

/** The Customer Service API and its keys (scope section 17). */
@Module({
  controllers: [CustomerServiceController, ApiClientsController],
  providers: [ApiClientGuard, ApiClientsService, CustomerServiceService],
})
export class CustomerServiceModule {}
