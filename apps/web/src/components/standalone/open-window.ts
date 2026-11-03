import { STANDALONE_SEGMENT, type StandaloneRecord } from './standalone-links';

/**
 * Opens one shipment or booking in a window of its own (a browser popup: no tabs, no editable
 * address bar in most desktop browsers) showing only that record. One window per record: opening it
 * again brings the same window back. Phones have no popups, so there it opens as a new tab.
 */
export function openStandaloneWindow(locale: string, record: StandaloneRecord): void {
  const name = `nolon-${record.kind}-${record.id.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const opened = window.open(
    `/${locale}/standalone/${STANDALONE_SEGMENT[record.kind]}/${encodeURIComponent(record.id)}`,
    name,
    'popup,width=1200,height=860',
  );
  opened?.focus();
}
