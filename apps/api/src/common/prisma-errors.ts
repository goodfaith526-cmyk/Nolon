import { Prisma } from '../generated/prisma/client.js';

/** True for a unique-constraint violation (P2002), e.g. two bookings for one quotation. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
