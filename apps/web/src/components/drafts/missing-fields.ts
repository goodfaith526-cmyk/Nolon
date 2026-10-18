/**
 * The PATCH body of a review screen's MissingFields form, from the values typed: no rule, only
 * where each value goes in the request.
 */

/**
 * `lines[0].quantity` → the list, the line and the field; `mode` → the field alone. A kind made of
 * two parts names the part first (`customer.name`, `quotation.lines[0].quantity`): its `group`.
 */
export interface MissingPath {
  path: string;
  field: string;
  group?: string;
  list?: string;
  index?: number;
}

export function parsePath(path: string): MissingPath {
  const m = /^(?:(\w+)\.)?(\w+)(?:\[(\d+)\]\.(\w+))?$/.exec(path);
  if (!m?.[2]) return { path, field: path };
  const group = m[1] === undefined ? {} : { group: m[1] };
  return m[4] === undefined
    ? { path, field: m[2], ...group }
    : { path, list: m[2], index: Number(m[3]), field: m[4], ...group };
}

/** The values of a new line, for a quotation draft saved without lines. */
export const NEW_LINE_FIELDS = ['chargeTypeCode', 'unit', 'quantity', 'unitPrice'] as const;

/** The values of a new line of an invoice draft saved without lines (an invoice line has no unit). */
export const NEW_INVOICE_LINE_FIELDS = ['chargeTypeCode', 'quantity', 'unitPrice'] as const;

/** Where a new line's value typed is kept: `lines.new.quantity`, `quotation.lines.new.quantity`. */
export function newLinePath(p: MissingPath, field: string): string {
  return `${p.path}.new.${field}`;
}

/** A value counted in whole pieces (a booking line's quantity, a release's packages), not typed. */
function isPieces(p: MissingPath): boolean {
  return p.field === 'packages' || (p.list === 'items' && p.field === 'quantity');
}

export type Value = string | string[];

/**
 * The PATCH body: each value typed, at its place in the request. A line's value goes in a copy of
 * the draft's lines (an edit replaces them as a whole); `lines` alone adds the new line typed.
 * Values left empty are not sent, so they stay missing.
 */
export function patchBody(
  request: object,
  paths: MissingPath[],
  values: Record<string, Value>,
  newLineFields: readonly string[] = NEW_LINE_FIELDS,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const record = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  // A part's values go in the body under the part's name (`customer`, `quotation`).
  const target = (group: string | undefined): Record<string, unknown> => {
    if (group === undefined) return body;
    const part = record(body[group]);
    body[group] = part;
    return part;
  };
  const lists = new Map<
    string,
    { group?: string; name: string; lines: Record<string, unknown>[] }
  >();
  const listOf = (group: string | undefined, name: string) => {
    const key = `${group ?? ''}.${name}`;
    let list = lists.get(key);
    if (!list) {
      const source = group === undefined ? record(request) : record(record(request)[group]);
      const current = source[name];
      list = {
        name,
        ...(group === undefined ? {} : { group }),
        lines: (Array.isArray(current) ? current : []).map((line: unknown) =>
          Object.fromEntries(Object.entries(record(line)).filter(([, v]) => v !== null)),
        ),
      };
      lists.set(key, list);
    }
    return list.lines;
  };
  for (const p of paths) {
    if (p.field === 'lines' && p.list === undefined) {
      const line: Record<string, unknown> = {};
      for (const field of newLineFields) {
        const value = values[newLinePath(p, field)];
        if (typeof value === 'string' && value !== '') line[field] = value;
      }
      if (Object.keys(line).length > 0) listOf(p.group, 'lines').push(line);
      continue;
    }
    const value = values[p.path];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    // Pieces are a whole number, not an amount; NOLON checks it. Every other value is sent as
    // typed.
    const typed = isPieces(p) && typeof value === 'string' ? Number(value) : value;
    if (p.list !== undefined && p.index !== undefined) {
      const line = listOf(p.group, p.list)[p.index];
      if (line) line[p.field] = typed;
    } else {
      target(p.group)[p.field] = typed;
    }
  }
  for (const list of lists.values()) target(list.group)[list.name] = list.lines;
  return body;
}
