import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Request } from 'express';
import { type ApiClientAuth, ApiClientGuard } from './api-client.guard.js';
import { type CustomerTokenAuth, CustomerTokenGuard } from './customer-token.guard.js';
import { readCustomerToken } from './customer-tokens.service.js';

/**
 * Who a booking-request call is from (docs/plans/04 section 7.1): a customer token (the request is
 * that customer's) or the key alone (the request is a channel identity's, named in the call).
 */
export type BookingRequestCaller =
  | { kind: 'customer'; client: ApiClientAuth; token: CustomerTokenAuth }
  | { kind: 'key'; client: ApiClientAuth };

interface CallerRequest extends Request {
  apiClient?: ApiClientAuth;
  customerToken?: CustomerTokenAuth;
  bookingCaller?: BookingRequestCaller;
}

/**
 * A customer token (`Bearer nolct_...`) goes through CustomerTokenGuard, every grant rechecked,
 * and its key must hold cs:booking_requests:create too; anything else through ApiClientGuard, with
 * the route's scope. Either way the key's branches are the ceiling for the request (section 6).
 */
@Injectable()
export class BookingRequestGuard implements CanActivate {
  constructor(
    private readonly keys: ApiClientGuard,
    private readonly tokens: CustomerTokenGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CallerRequest>();
    if (readCustomerToken(request.headers.authorization)) {
      await this.tokens.canActivate(context);
      const token = request.customerToken;
      if (!token) throw new InternalServerErrorException('No customer token');
      if (!token.client.scopes.includes('cs:booking_requests:create')) {
        throw new ForbiddenException({
          message: 'This API key does not hold the scope cs:booking_requests:create',
          code: 'SCOPE_REQUIRED',
          error: 'Forbidden',
          statusCode: 403,
        });
      }
      request.bookingCaller = { kind: 'customer', client: token.client, token };
      return true;
    }
    await this.keys.canActivate(context);
    const client = request.apiClient;
    if (!client) throw new InternalServerErrorException('No API client');
    request.bookingCaller = { kind: 'key', client };
    return true;
  }
}

export const CurrentBookingCaller = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const caller = ctx.switchToHttp().getRequest<CallerRequest>().bookingCaller;
    if (!caller) throw new InternalServerErrorException('No booking-request caller on this route');
    return caller;
  },
);
