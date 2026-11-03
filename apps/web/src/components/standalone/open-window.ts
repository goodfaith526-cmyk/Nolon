/**
 * Opens one shipment in a window of its own (a browser popup: no tabs, no editable address bar in
 * most desktop browsers) showing only the shipment page. One window per shipment: opening it again
 * brings the same window back. Phones have no popups, so there it opens as a new tab.
 */
export function openShipmentWindow(locale: string, shipmentId: string): void {
  const name = `nolon-shipment-${shipmentId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const opened = window.open(
    `/${locale}/standalone/shipments/${encodeURIComponent(shipmentId)}`,
    name,
    'popup,width=1200,height=860',
  );
  opened?.focus();
}
