import { Prisma } from '../generated/prisma/client.js';

/**
 * CBM calculator (scope 7): volume in cubic metres of `quantity` pieces of L × W × H centimetres,
 * rounded half up to 4 decimal places (the column's scale). Exact decimal arithmetic.
 */
export function cbmFromDimensions(
  lengthCm: Prisma.Decimal,
  widthCm: Prisma.Decimal,
  heightCm: Prisma.Decimal,
  quantity: number,
): Prisma.Decimal {
  return lengthCm
    .mul(widthCm)
    .mul(heightCm)
    .mul(quantity)
    .div(1_000_000)
    .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}
