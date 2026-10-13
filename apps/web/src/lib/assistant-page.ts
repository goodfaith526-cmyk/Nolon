// The assistant button in the top bar, on a shipment's or a customer's page, opens the assistant
// on that record: the address names it in the fragment (never sent in a request). The assistant
// reads it again in NOLON with the staff member's own token, so the link grants nothing.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The staff pages whose record the assistant can open on, by the assistant's name for it. */
const PAGES: Readonly<Record<string, string>> = {
  shipments: 'shipment',
  customers: 'customer',
};

/** The record of a staff page (`/shipments/<id>`, with or without a locale), or null. */
export function pageRecord(pathname: string): { kind: string; id: string } | null {
  const parts = pathname.split('/').filter(Boolean);
  const [section, id, ...rest] = /^(ar|en)$/.test(parts[0] ?? '') ? parts.slice(1) : parts;
  if (rest.length > 0 || !section || !id || !UUID.test(id)) return null;
  const kind = Object.hasOwn(PAGES, section) ? PAGES[section] : undefined;
  return kind ? { kind, id: id.toLowerCase() } : null;
}

/** The assistant's address for this page: on its record when it has one, else as it is. */
export function assistantPageUrl(assistantUrl: string, pathname: string): string {
  const record = pageRecord(pathname);
  if (!record) return assistantUrl;
  const url = new URL(assistantUrl);
  url.hash = `record=${record.kind}:${record.id}`;
  return url.toString();
}
