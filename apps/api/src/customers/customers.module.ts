import { Module } from '@nestjs/common';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

@Module({
  imports: [CurrenciesModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
