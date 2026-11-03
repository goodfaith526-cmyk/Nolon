/** The one record a standalone window shows. */
export interface StandaloneRecord {
  kind: 'shipment' | 'booking';
  id: string;
}

/** The URL segment of each kind (/standalone/<segment>/:id, /print/<segment>/:id). */
export const STANDALONE_SEGMENT: Record<StandaloneRecord['kind'], string> = {
  shipment: 'shipments',
  booking: 'bookings',
};

/**
 * The links a standalone window keeps. The window shows one shipment or booking and nothing else,
 * so every other link (a customer, a booking, an invoice, a trip...) does nothing there:
 * - a shipment's files (a download; the window stays on the shipment);
 * - the record's printouts and the public tracking page, which open in a new tab.
 * The API still checks every permission and branch; this only keeps the window on its page.
 */
export function isAllowedInStandalone(
  href: string,
  origin: string,
  record: StandaloneRecord,
): boolean {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  // The path without its locale prefix (/ar/print/... and /print/... are the same page).
  const path = url.pathname.replace(/^\/(ar|en)(?=\/)/, '');
  const id = encodeURIComponent(record.id);
  const print = `/print/${STANDALONE_SEGMENT[record.kind]}/${id}`;
  return (
    (record.kind === 'shipment' && path.startsWith(`/api/v1/shipments/${id}/documents/`)) ||
    path === print ||
    path.startsWith(`${print}/`) ||
    /^\/track\/[^/]+$/.test(path)
  );
}

const BLOCKED = 'data-standalone-blocked';

/** Marks each link the window does not keep: shown as plain text, out of the keyboard order. */
function mark(link: HTMLAnchorElement, origin: string, record: StandaloneRecord) {
  const href = link.getAttribute('href');
  if (href !== null && isAllowedInStandalone(href, origin, record)) {
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
 * Keeps a standalone window on its record: every link it does not keep is marked (and styled as
 * plain text), and a click on one (mouse, middle button or keyboard) is stopped before the page's
 * own handlers see it. Returns the clean-up.
 */
export function guardStandaloneLinks(root: HTMLElement, record: StandaloneRecord): () => void {
  const doc = root.ownerDocument;
  const origin = doc.defaultView?.location.origin ?? '';

  const markAll = (node: ParentNode) => {
    if (node instanceof HTMLAnchorElement) mark(node, origin, record);
    node.querySelectorAll('a').forEach((link) => mark(link, origin, record));
  };
  markAll(root);

  const observer = new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === 'attributes' && change.target instanceof HTMLAnchorElement) {
        mark(change.target, origin, record);
      }
      change.addedNodes.forEach((node) => {
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
    if (href !== null && isAllowedInStandalone(href, origin, record)) return;
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
