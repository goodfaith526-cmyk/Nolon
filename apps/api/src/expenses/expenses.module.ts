import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { ExpensesController } from './expenses.controller.js';
import { ExpenseReportsService } from './expense-reports.service.js';
import { ExpensesService } from './expenses.service.js';

/** General expenses (scope 13): not tied to a shipment or trip, paid from cash or bank. */
@Module({
  imports: [AccountingModule, CurrenciesModule],
  controllers: [ExpensesController],
  providers: [ExpensesService, ExpenseReportsService],
  exports: [ExpenseReportsService],
})
export class ExpensesModule {}
