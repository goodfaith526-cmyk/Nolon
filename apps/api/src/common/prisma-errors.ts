import { Prisma } from '../generated/prisma/client.js';

/** True for a unique-constraint violation (P2002), e.g. two bookings for one quotation. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** True for a foreign-key violation (P2003), e.g. removing a row an invoice line still names. */
export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}
