/**
 * Layout helpers for the printouts. They lay out what the API returned; they decide nothing.
 */

/** Most labels one print run lays out; a larger shipment is printed line by line. */
export const MAX_LABELS = 500;

/** A cargo line as the shipment returned it (only what a label shows). */
export interface LabelLine {
  lineNo: number;
  quantity: number;
}

/** One package label: package `index` of `total`, from cargo line `lineNo`. */
export interface PackageLabel<T extends LabelLine> {
  index: number;
  total: number;
  line: T;
}

/**
 * One label per package, in cargo-line order: a line of quantity 3 gives three labels, numbered
 * across the whole shipment ("4 of 10"); `total` is the shipment's package count as the API gave
 * it. With `onlyLine`, only that line's labels (still numbered across the shipment). Labels start
 * at package `from` (default 1) and at most `max` are laid out in one batch; when more remain,
 * `nextFrom` is the package number the next batch starts at (null when this batch is the last).
 */
export function packageLabels<T extends LabelLine>(
  lines: readonly T[],
  total: number,
  options: { onlyLine?: number; from?: number; max?: number } = {},
): { labels: PackageLabel<T>[]; nextFrom: number | null } {
  const max = options.max ?? MAX_LABELS;
  const from = Math.max(1, options.from ?? 1);
  const labels: PackageLabel<T>[] = [];
  let index = 0;
  for (const line of lines) {
    const count = Math.max(0, line.quantity);
    const wanted = options.onlyLine === undefined || line.lineNo === options.onlyLine;
    // Lines entirely before the batch, or not printed, only move the numbering on.
    if (!wanted || index + count < from) {
      index += count;
      continue;
    }
    for (let i = 0; i < count; i++) {
      index += 1;
      if (index < from) continue;
      if (labels.length === max) return { labels, nextFrom: index };
      labels.push({ index, total, line });
    }
  }
  return { labels, nextFrom: null };
}

/** The first day of the year of a yyyy-mm-dd date. */
export function startOfYear(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}
