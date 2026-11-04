// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardStandaloneLinks, isAllowedInStandalone } from './standalone-links';

const origin = 'https://nolon.example';
const id = { kind: 'shipment', id: 'shp-1' } as const;

describe('isAllowedInStandalone', () => {
  it.each([
    ['/ar/print/shipments/shp-1', true],
    ['/en/print/shipments/shp-1/labels', true],
    ['/print/shipments/shp-1/pods/p1', true],
    ['/api/v1/shipments/shp-1/documents/d1/file', true],
    [`${origin}/track/abc123`, true],
    ['/ar/track/abc123', true],
  ])('keeps %s', (href, allowed) => {
    expect(isAllowedInStandalone(href, origin, id)).toBe(allowed);
  });

  it.each([
    '/ar/shipments/shp-1',
    '/ar/bookings/b1',
    '/ar/invoices/i1',
    '/ar/trips/new?shipmentId=shp-1',
    '/ar/dashboard',
    '/ar/print/shipments/shp-10',
    '/ar/print/shipments/shp-2',
    '/ar/print/invoices/i1',
    '/api/v1/shipments/shp-2/documents/d1/file',
    '/api/v1/customers/c1',
    '/ar/track',
    '/ar/track/abc/../../dashboard',
    'https://elsewhere.example/print/shipments/shp-1',
    'javascript:alert(1)',
    '/ar/standalone/shipments/shp-2',
  ])('switches off %s', (href) => {
    expect(isAllowedInStandalone(href, origin, id)).toBe(false);
  });
});

describe('guardStandaloneLinks', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function setup(html: string) {
    const root = document.createElement('main');
    root.innerHTML = html;
    document.body.append(root);
    const cleanup = guardStandaloneLinks(root, id);
    return { root, cleanup };
  }

  /** Whether the guard stopped the click (jsdom cannot navigate, so a kept one is stopped after). */
  function click(el: Element, type: 'click' | 'auxclick' = 'click') {
    let stopped = true;
    const after = (event: Event) => {
      stopped = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener(type, after);
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: type === 'auxclick' ? 1 : 0,
      }),
    );
    document.removeEventListener(type, after);
    return { defaultPrevented: stopped };
  }

  it("stops a link to another page before the page sees it, and keeps this shipment's printout", () => {
    const { root, cleanup } = setup(
      '<a id="booking" href="/ar/bookings/b1"><span>Booking</span></a>' +
        '<a id="print" href="/ar/print/shipments/shp-1" target="_blank">Print</a>',
    );
    const seen = vi.fn();
    root.addEventListener('click', seen);

    const blocked = click(root.querySelector('#booking span') as Element);
    expect(blocked.defaultPrevented).toBe(true);
    expect(click(root.querySelector('#booking') as Element, 'auxclick').defaultPrevented).toBe(
      true,
    );
    expect(seen).not.toHaveBeenCalled();

    const kept = click(root.querySelector('#print') as Element);
    expect(kept.defaultPrevented).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('marks blocked links (also ones added or changed later) and lets go on clean-up', async () => {
    const { root, cleanup } = setup('<a id="trip" href="/ar/trips/t1">T1</a>');
    const trip = root.querySelector('#trip') as HTMLAnchorElement;
    expect(trip.hasAttribute('data-standalone-blocked')).toBe(true);
    expect(trip.getAttribute('aria-disabled')).toBe('true');
    expect(trip.getAttribute('tabindex')).toBe('-1');

    const added = document.createElement('div');
    added.innerHTML = '<a id="invoice" href="/ar/invoices/i1">INV</a>';
    root.append(added);
    trip.setAttribute('href', '/ar/print/shipments/shp-1/labels');
    await Promise.resolve();
    expect(root.querySelector('#invoice')?.hasAttribute('data-standalone-blocked')).toBe(true);
    expect(trip.hasAttribute('data-standalone-blocked')).toBe(false);
    expect(trip.hasAttribute('tabindex')).toBe(false);

    cleanup();
    expect(click(root.querySelector('#invoice') as Element).defaultPrevented).toBe(false);
  });

  it("leaves links outside the window's page alone", () => {
    const { cleanup } = setup('');
    const outside = document.createElement('a');
    outside.href = '/ar/bookings/b1';
    document.body.append(outside);
    expect(click(outside).defaultPrevented).toBe(false);
    cleanup();
  });
});

describe('isAllowedInStandalone for a booking window', () => {
  const booking = { kind: 'booking', id: 'bk-1' } as const;

  it.each([
    ['/ar/print/bookings/bk-1', true],
    ['/print/bookings/bk-1', true],
    ['/ar/track/abc123', true],
    ['/ar/print/bookings/bk-2', false],
    ['/ar/print/shipments/bk-1', false],
    ['/api/v1/shipments/bk-1/documents/d1/file', false],
    ['/ar/shipments/s1', false],
    ['/ar/bookings/bk-1/edit', false],
    ['/ar/quotations/q1', false],
  ])('%s -> %s', (href, allowed) => {
    expect(isAllowedInStandalone(href, origin, booking)).toBe(allowed);
  });
});
