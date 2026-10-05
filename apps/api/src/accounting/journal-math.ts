import { BASE_CURRENCY } from '@nolon/shared';
import { type Decimal, ZERO, dec, roundMoney } from '../common/money.js';
import { Prisma } from '../generated/prisma/client.js';

/**
 * Journal arithmetic, in one place (AGENTS.md rule 1: rounding is explicit and done once). Every
 * line is converted to USD, the reporting currency, rounded to cents; an entry balances when its
 * USD debits equal its USD credits. The few cents that per-line rounding leaves are booked to the
 * rounding account; anything larger is an unbalanced entry.
 */

/** USD minor units. */
export const USD_DECIMALS = 2;

/** Per line, the most that rounding to cents can leave: one cent. */
const ROUNDING_PER_LINE = dec('0.01');

export type Side = 'DEBIT' | 'CREDIT';

export interface LineSpec {
  accountId: string;
  branchId: string;
  currency: string;
  /** Units of `currency` per 1 USD; 1 for USD. */
  fxRate: Decimal;
  side: Side;
  /** In `currency`, already rounded to its minor units. Positive. */
  amount: Decimal;
  /** Set when the USD value is not amount / rate, e.g. the receivable a payment clears. */
  amountUsd?: Decimal;
  shipmentId?: string | null;
  customerId?: string | null;
  supplierId?: string | null;
  /** Accrued transport lines (rules 11 and 11a): the trip the accrual belongs to. */
  tripId?: string | null;
  description?: string | null;
}

export interface PreparedLine extends LineSpec {
  amountUsd: Decimal;
}

export class UnbalancedEntryError extends Error {
  constructor(
    readonly debitUsd: Decimal,
    readonly creditUsd: Decimal,
  ) {
    super(
      `Entry is unbalanced: debit ${debitUsd.toFixed()} USD, credit ${creditUsd.toFixed()} USD`,
    );
  }
}

export class InvalidLineError extends Error {}

export const AMOUNT_TOO_SMALL =
  'The amount is too small to post in USD: it rounds to 0.00 USD at this exchange rate';

export function toUsd(amount: Decimal, fxRate: Decimal, currency: string): Decimal {
  if (currency === BASE_CURRENCY) return amount;
  return roundMoney(amount.div(fxRate), USD_DECIMALS);
}

export function totals(lines: readonly PreparedLine[]): { debitUsd: Decimal; creditUsd: Decimal } {
  let debitUsd = ZERO;
  let creditUsd = ZERO;
  for (const line of lines) {
    if (line.side === 'DEBIT') debitUsd = debitUsd.plus(line.amountUsd);
    else creditUsd = creditUsd.plus(line.amountUsd);
  }
  return { debitUsd, creditUsd };
}

/**
 * Converts each line to USD and balances the entry. When USD debits and credits differ by no more
 * than one cent per line, a line on the rounding account (in the entry's branch) takes up the
 * difference; a larger difference throws UnbalancedEntryError. An entry worth 0.00 USD in total
 * throws InvalidLineError: lines whose own USD value rounds to zero are kept (with their amount in
 * their currency), as long as the entry as a whole is worth at least a cent.
 */
export function prepareLines(
  lines: readonly LineSpec[],
  rounding: { accountId: string; branchId: string },
): PreparedLine[] {
  const prepared = lines.map((line): PreparedLine => {
    if (!line.amount.gt(0)) throw new InvalidLineError('Line amounts must be positive');
    if (!line.fxRate.gt(0)) throw new InvalidLineError('Exchange rates must be positive');
    if (line.currency === BASE_CURRENCY && !line.fxRate.eq(1)) {
      throw new InvalidLineError('USD lines have rate 1');
    }
    const amountUsd = line.amountUsd ?? toUsd(line.amount, line.fxRate, line.currency);
    if (line.currency === BASE_CURRENCY && !amountUsd.eq(line.amount)) {
      throw new InvalidLineError('A USD line has the same amount in USD');
    }
    if (amountUsd.lt(0)) throw new InvalidLineError('USD amounts cannot be negative');
    return { ...line, amountUsd };
  });
  const { debitUsd, creditUsd } = totals(prepared);
  // Every line rounds to 0.00 USD (e.g. 1 SDG at 600): there is nothing to post in the reporting
  // currency, and the database refuses an entry of zero. Checked before the line count, as an
  // opening entry worth nothing has no equity line to balance it.
  if (prepared.length > 0 && debitUsd.isZero() && creditUsd.isZero()) {
    throw new InvalidLineError(AMOUNT_TOO_SMALL);
  }
  if (lines.length < 2) throw new InvalidLineError('An entry needs at least two lines');
  const difference = debitUsd.minus(creditUsd);
  if (difference.isZero()) return prepared;
  if (difference.abs().gt(ROUNDING_PER_LINE.times(prepared.length))) {
    throw new UnbalancedEntryError(debitUsd, creditUsd);
  }
  prepared.push({
    accountId: rounding.accountId,
    branchId: rounding.branchId,
    currency: BASE_CURRENCY,
    fxRate: dec(1),
    side: difference.gt(0) ? 'CREDIT' : 'DEBIT',
    amount: difference.abs(),
    amountUsd: difference.abs(),
    description: 'Rounding',
  });
  return prepared;
}

/** The lines of a reversing entry: same amounts and rates, sides swapped. */
export function reverseLines(lines: readonly PreparedLine[]): PreparedLine[] {
  return lines.map((line) => ({ ...line, side: line.side === 'DEBIT' ? 'CREDIT' : 'DEBIT' }));
}

/**
 * Splits `total` (in a currency with `decimalPlaces` minor units) in proportion to `weights`,
 * exactly: each share is rounded down to the minor unit, and the units left over go one each to
 * the largest remainders (the earlier share on a tie). The shares always add up to `total`. With
 * no positive weight, the total is split equally.
 */
export function splitAmount(
  total: Decimal,
  weights: readonly Decimal[],
  decimalPlaces: number,
): Decimal[] {
  if (weights.length === 0) throw new InvalidLineError('Nothing to split the amount over');
  if (total.lt(0)) throw new InvalidLineError('Only a positive amount is split');
  if (weights.some((w) => w.lt(0))) throw new InvalidLineError('Split weights cannot be negative');
  if (!roundMoney(total, decimalPlaces).eq(total)) {
    throw new InvalidLineError('The amount to split has more decimals than its currency');
  }
  const sum = weights.reduce((acc, w) => acc.plus(w), ZERO);
  const basis = sum.gt(0) ? weights : weights.map(() => dec(1));
  const basisSum = sum.gt(0) ? sum : dec(weights.length);
  const exact = basis.map((w) => total.times(w).div(basisSum));
  const shares = exact.map((x) => x.toDecimalPlaces(decimalPlaces, Prisma.Decimal.ROUND_DOWN));
  const unit = dec(1).div(dec(10).pow(decimalPlaces));
  let left = total.minus(shares.reduce((acc, x) => acc.plus(x), ZERO));
  const byRemainder = exact
    .map((x, index) => ({ index, remainder: x.minus(shares[index] ?? ZERO) }))
    .sort((a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index);
  for (const { index } of byRemainder) {
    if (!left.gt(0)) break;
    shares[index] = (shares[index] ?? ZERO).plus(unit);
    left = left.minus(unit);
  }
  return shares;
}
