/**
 * The links a standalone shipment window keeps. The window shows one shipment and nothing else,
 * so every other link (a customer, a booking, an invoice, a trip...) does nothing there:
 * - this shipment's files (a download; the window stays on the shipment);
 * - this shipment's printouts and its public tracking page, which open in a new tab.
 * The API still checks every permission and branch; this only keeps the window on its page.
 */
export function isAllowedInStandalone(href: string, origin: string, shipmentId: string): boolean {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  // The path without its locale prefix (/ar/print/... and /print/... are the same page).
  const path = url.pathname.replace(/^\/(ar|en)(?=\/)/, '');
  const id = encodeURIComponent(shipmentId);
  const print = `/print/shipments/${id}`;
  return (
    path.startsWith(`/api/v1/shipments/${id}/documents/`) ||
    path === print ||
    path.startsWith(`${print}/`) ||
    /^\/track\/[^/]+$/.test(path)
  );
}

const BLOCKED = 'data-standalone-blocked';

/** Marks each link the window does not keep: shown as plain text, out of the keyboard order. */
function mark(link: HTMLAnchorElement, origin: string, shipmentId: string) {
  const href = link.getAttribute('href');
  if (href !== null && isAllowedInStandalone(href, origin, shipmentId)) {
    if (link.hasAttribute(BLOCKED)) {
      link.removeAttribute(BLOCKED);
      link.removeAttribute('aria-disabled');
      link.removeAttribute('tabindex');
    }
    return;
  }
  link.setAttribute(BLOCKED, '');
  link.setAttribute('aria-disabled', 'true');
  link.setAttribute('tabindex', '-1');
}

/**
 * Keeps a standalone window on its shipment: every link it does not keep is marked (and styled as
 * plain text), and a click on one (mouse, middle button or keyboard) is stopped before the page's
 * own handlers see it. Returns the clean-up.
 */
export function guardStandaloneLinks(root: HTMLElement, shipmentId: string): () => void {
  const doc = root.ownerDocument;
  const origin = doc.defaultView?.location.origin ?? '';

  const markAll = (node: ParentNode) => {
    if (node instanceof HTMLAnchorElement) mark(node, origin, shipmentId);
    node.querySelectorAll('a').forEach((link) => mark(link, origin, shipmentId));
  };
  markAll(root);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLAnchorElement) {
        mark(record.target, origin, shipmentId);
      }
      record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) markAll(node);
      });
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['href'],
  });

  // Capture on the document runs before React's own listeners (on the page root) and Next's Link.
  const stop = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('a');
    if (!link || !root.contains(link)) return;
    const href = link.getAttribute('href');
    if (href !== null && isAllowedInStandalone(href, origin, shipmentId)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  doc.addEventListener('click', stop, true);
  doc.addEventListener('auxclick', stop, true);

  return () => {
    observer.disconnect();
    doc.removeEventListener('click', stop, true);
    doc.removeEventListener('auxclick', stop, true);
  };
}
