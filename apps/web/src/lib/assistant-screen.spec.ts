import { describe, expect, it } from 'vitest';
import { type FrameWindow, HELLO, SCREEN, createScreenHost, screenOf } from './assistant-screen';

const ORIGIN = 'https://assistant.nolon.example';
const BOOKING = '0b7f1d52-6a4e-4c39-9d2b-3f1a8e5c7d10';
const SHIPMENT = '5c2e8a71-1f3b-4d6a-8e9c-7b4d2a1f6e03';
const SESSION = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const SESSION_2 = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

function setup(screen: { kind: string; id: string } | null = null) {
  const sent: { message: unknown; target: string }[] = [];
  const frame: FrameWindow = {
    postMessage: (message, target) => sent.push({ message, target }),
  };
  const other: FrameWindow = { postMessage: () => {} };
  let listener: ((event: MessageEvent) => void) | null = null;
  const win = {
    addEventListener: (_: 'message', l: (event: MessageEvent) => void) => (listener = l),
    removeEventListener: () => (listener = null),
  };
  let current: FrameWindow | null = frame;
  const host = createScreenHost({ origin: ORIGIN, win, frame: () => current, screen });
  function receive(data: unknown, from: { origin?: string; source?: unknown } = {}) {
    listener?.({
      data,
      origin: from.origin ?? ORIGIN,
      source: 'source' in from ? from.source : frame,
    } as MessageEvent);
  }
  const hello = (session = SESSION) => ({ type: HELLO, v: 1, session });
  return {
    host,
    sent,
    other,
    receive,
    hello,
    listening: () => listener !== null,
    detach: () => (current = null),
  };
}

describe('the screen of a staff page', () => {
  it('is the booking or shipment on its record page, with or without a locale', () => {
    expect(screenOf(`/bookings/${BOOKING}`)).toEqual({ kind: 'booking', id: BOOKING });
    expect(screenOf(`/ar/shipments/${SHIPMENT.toUpperCase()}`)).toEqual({
      kind: 'shipment',
      id: SHIPMENT,
    });
  });

  it('is none on lists, other records, sub-pages and ids that are not UUIDs', () => {
    for (const path of [
      '/bookings',
      `/customers/${BOOKING}`,
      `/invoices/${BOOKING}`,
      `/bookings/${BOOKING}/edit`,
      '/shipments/new',
      '/dashboard',
    ]) {
      expect(screenOf(path)).toBeNull();
    }
  });
});

describe('the screen host', () => {
  it('sends nothing before the assistant says hello', () => {
    const { host, sent } = setup({ kind: 'booking', id: BOOKING });
    host.setScreen({ kind: 'shipment', id: SHIPMENT });
    expect(sent).toEqual([]);
  });

  it("answers a hello with the current screen, to the assistant's exact origin", () => {
    const { sent, receive, hello } = setup({ kind: 'booking', id: BOOKING });
    receive(hello());
    expect(sent).toEqual([
      {
        message: {
          type: SCREEN,
          v: 1,
          session: SESSION,
          seq: 1,
          screen: { kind: 'booking', id: BOOKING },
        },
        target: ORIGIN,
      },
    ]);
  });

  it('sends each change once, numbered, and null when the page has no supported record', () => {
    const { host, sent, receive, hello } = setup();
    receive(hello());
    host.setScreen({ kind: 'booking', id: BOOKING });
    host.setScreen({ kind: 'booking', id: BOOKING });
    host.setScreen({ kind: 'shipment', id: SHIPMENT });
    host.setScreen(null);
    host.setScreen(null);
    expect(sent.map((s) => s.message)).toEqual([
      { type: SCREEN, v: 1, session: SESSION, seq: 1, screen: null },
      { type: SCREEN, v: 1, session: SESSION, seq: 2, screen: { kind: 'booking', id: BOOKING } },
      {
        type: SCREEN,
        v: 1,
        session: SESSION,
        seq: 3,
        screen: { kind: 'shipment', id: SHIPMENT },
      },
      { type: SCREEN, v: 1, session: SESSION, seq: 4, screen: null },
    ]);
  });

  it('answers a repeated hello with the next number, and a new session from 1 again', () => {
    const { sent, receive, hello } = setup();
    receive(hello());
    receive(hello());
    receive(hello(SESSION_2));
    expect(sent.map((s) => s.message)).toMatchObject([
      { session: SESSION, seq: 1 },
      { session: SESSION, seq: 2 },
      { session: SESSION_2, seq: 1 },
    ]);
  });

  it('ignores a hello from another origin, another window, or of another shape or version', () => {
    const { sent, receive, hello, other } = setup({ kind: 'booking', id: BOOKING });
    receive(hello(), { origin: 'https://evil.example' });
    receive(hello(), { origin: 'https://nolon.example' });
    receive(hello(), { source: other });
    receive(hello(), { source: null });
    receive({ ...hello(), v: 2 });
    receive({ ...hello(), type: SCREEN });
    receive({ type: HELLO, v: 1 });
    receive({ type: HELLO, v: 1, session: 'not-a-uuid' });
    receive('erp-agents:hello');
    receive(null);
    expect(sent).toEqual([]);
  });

  it('sends nothing when the frame is gone, and stops listening when stopped', () => {
    const { host, sent, receive, hello, detach, listening } = setup();
    receive(hello());
    detach();
    host.setScreen({ kind: 'booking', id: BOOKING });
    expect(sent).toHaveLength(1);
    host.stop();
    expect(listening()).toBe(false);
  });
});
