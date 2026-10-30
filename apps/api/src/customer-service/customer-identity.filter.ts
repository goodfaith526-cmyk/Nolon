import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

/** Preserve the machine error and the shared limiter's HTTP retry instruction without logging PII. */
@Catch()
export class CustomerIdentityFilter implements ExceptionFilter<unknown> {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (!(error instanceof HttpException)) {
      // Database errors may contain a whole failing row; never log that message/stack/context.
      const name = error instanceof Error ? error.name : 'UnknownError';
      Logger.error(`Customer identity persistence failed (${name})`, 'CustomerIdentity');
      const status = name.startsWith('PrismaClient') ? 503 : 500;
      response.status(status).json({
        statusCode: status,
        code: status === 503 ? 'CUSTOMER_CAPTURE_UNAVAILABLE' : 'INTERNAL_ERROR',
      });
      return;
    }
    const body = error.getResponse();
    if (
      error.getStatus() === 429 &&
      typeof body === 'object' &&
      body !== null &&
      'retryAfterSeconds' in body
    ) {
      response.setHeader('Retry-After', String(body.retryAfterSeconds));
    }
    response
      .status(error.getStatus())
      .json(typeof body === 'string' ? { statusCode: error.getStatus(), message: body } : body);
  }
}
