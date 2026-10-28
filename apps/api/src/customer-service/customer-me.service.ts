import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CsInvoiceDto,
  CsInvoiceState,
  CsShipmentDto,
  CsShipmentState,
  CsShipmentSummaryDto,
} from '@nolon/shared';
import type { CustomerTokenAuth } from './customer-token.guard.js';
import { CustomerServiceService } from './customer-service.service.js';
import { CustomerTokensService } from './customer-tokens.service.js';

/**
 * A shipment number as a customer may write it: any case, and the older NOL-SHP-2026-000125 also
 * without `NOL-`. The newer BK00125 and DXB-KRT-0001 are kept as they are. A number from before a
 * renumbering is then found through the renumbering log (CustomerServiceService.shipment).
 */
export function customerShipmentNumber(raw: string): string {
  const number = raw.trim().toUpperCase();
  return /^SHP-\d{4}-\d{6}$/.test(number) ? `NOL-${number}` : number;
}

/**
 * The reads of one customer with a customer token (N2). The customer comes from the token only,
 * and the reads are those of the Customer Service API, limited to that customer and the key's
 * branches. Each read is in the access log (N4).
 */
@Injectable()
export class CustomerMeService {
  constructor(
    private readonly cs: CustomerServiceService,
    private readonly tokens: CustomerTokensService,
  ) {}

  async shipments(
    auth: CustomerTokenAuth,
    state: CsShipmentState,
    limit: number,
  ): Promise<CsShipmentSummaryDto[]> {
    const list = await this.cs.shipments(auth.client, auth.customerNumber, state, limit);
    await this.record(auth, 'OK', 'GET /cs/me/shipments');
    return list;
  }

  async shipment(auth: CustomerTokenAuth, number: string): Promise<CsShipmentDto> {
    const route = 'GET /cs/me/shipments/:number';
    try {
      const found = await this.cs.shipment(
        auth.client,
        customerShipmentNumber(number),
        auth.customerId,
        true,
      );
      await this.record(auth, 'OK', route);
      return found;
    } catch (error) {
      if (error instanceof NotFoundException) await this.record(auth, 'NOT_FOUND', route);
      throw error;
    }
  }

  /** Invoices need L2: a proof of an email code (N3). */
  async invoices(
    auth: CustomerTokenAuth,
    state: CsInvoiceState,
    limit: number,
  ): Promise<CsInvoiceDto[]> {
    const route = 'GET /cs/me/invoices';
    if (auth.level !== 'L2') {
      await this.record(auth, 'L2_REQUIRED', route);
      throw new ForbiddenException({
        message: 'Invoices need a verified email code (L2)',
        code: 'L2_REQUIRED',
        error: 'Forbidden',
        statusCode: 403,
      });
    }
    const list = await this.cs.invoices(auth.client, auth.customerNumber, state, limit);
    await this.record(auth, 'OK', route);
    return list;
  }

  private record(auth: CustomerTokenAuth, outcome: string, route: string): Promise<void> {
    return this.tokens.record(auth.client.id, auth.tokenId, auth.customerId, outcome, route);
  }
}
