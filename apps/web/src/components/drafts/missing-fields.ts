/**
 * The PATCH body of a review screen's MissingFields form, from the values typed: no rule, only
 * where each value goes in the request.
 */

/** `lines[0].quantity` → the list, the line and the field; `mode` → the field alone. */
export interface MissingPath {
  path: string;
  field: string;
  list?: string;
  index?: number;
}

export function parsePath(path: string): MissingPath {
  const m = /^(\w+)\[(\d+)\]\.(\w+)$/.exec(path);
  return m ? { path, list: m[1], index: Number(m[2]), field: m[3] ?? path } : { path, field: path };
}

/** The values of a new line, for a quotation draft saved without lines. */
export const NEW_LINE_FIELDS = ['chargeTypeCode', 'unit', 'quantity', 'unitPrice'] as const;

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
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const lists = new Map<string, Record<string, unknown>[]>();
  const listOf = (name: string) => {
    let list = lists.get(name);
    if (!list) {
      const current: unknown = (request as Record<string, unknown>)[name];
      list = (Array.isArray(current) ? current : []).map((line: unknown) =>
        Object.fromEntries(
          Object.entries(line as Record<string, unknown>).filter(([, v]) => v !== null),
        ),
      );
      lists.set(name, list);
    }
    return list;
  };
  for (const p of paths) {
    if (p.path === 'lines') {
      const line: Record<string, unknown> = {};
      for (const field of NEW_LINE_FIELDS) {
        const value = values[`lines.new.${field}`];
        if (typeof value === 'string' && value !== '') line[field] = value;
      }
      if (Object.keys(line).length > 0) listOf('lines').push(line);
      continue;
    }
    const value = values[p.path];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    if (p.list !== undefined && p.index !== undefined) {
      const line = listOf(p.list)[p.index];
      // A booking line counts pieces (a whole number, not an amount); NOLON checks it. Every
      // other value is sent as typed.
      const pieces = p.list === 'items' && p.field === 'quantity' && typeof value === 'string';
      if (line) line[p.field] = pieces ? Number(value) : value;
    } else {
      body[p.field] = value;
    }
  }
  for (const [name, list] of lists) body[name] = list;
  return body;
}
