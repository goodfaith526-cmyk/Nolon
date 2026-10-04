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
 * One label per package, in cargo-line order: a line of quantity 3 gives three labels. Each label
 * is numbered across the whole shipment ("4 of 10"). With `onlyLine`, only that line's labels
 * (still numbered across the shipment). At most `max` labels are laid out; `truncated` says some
 * were left out.
 */
export function packageLabels<T extends LabelLine>(
  lines: readonly T[],
  options: { onlyLine?: number; max?: number } = {},
): { labels: PackageLabel<T>[]; total: number; truncated: boolean } {
  const max = options.max ?? MAX_LABELS;
  const total = lines.reduce((n, l) => n + Math.max(0, l.quantity), 0);
  const labels: PackageLabel<T>[] = [];
  let index = 0;
  let truncated = false;
  for (const line of lines) {
    for (let i = 0; i < Math.max(0, line.quantity); i++) {
      index += 1;
      if (options.onlyLine !== undefined && line.lineNo !== options.onlyLine) continue;
      if (labels.length >= max) {
        truncated = true;
        continue;
      }
      labels.push({ index, total, line });
    }
  }
  return { labels, total, truncated };
}

/** The first day of the year of a yyyy-mm-dd date. */
export function startOfYear(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}
