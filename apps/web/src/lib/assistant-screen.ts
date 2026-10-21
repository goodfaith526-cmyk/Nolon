// The assistant panel's screen context (erp-agents docs/screen-context.md, version 1): NOLON tells
// the assistant framed beside its pages which booking or shipment is open, as a kind and an id
// only. The assistant shows it and never acts on it by itself: using the record is the staff
// member's choice there, after which the assistant reads it again in NOLON with their own token,
// so a message grants nothing. No DOM here: the panel passes the window and the frame, so the
// checks are unit tested.

import { recordOf } from './assistant-page';

/** The contract's version. A hello of another version is ignored. */
export const SCREEN_CONTEXT_VERSION = 1;
export const HELLO = 'erp-agents:hello';
export const SCREEN = 'erp-agents:screen';

/** The staff pages the assistant reads as a screen, by the assistant's name for their kind. */
const SCREEN_PAGES: Readonly<Record<string, string>> = {
  bookings: 'booking',
  shipments: 'shipment',
};

export interface Screen {
  kind: string;
  id: string;
}

/** The booking or shipment open on this page, or null on any other page. */
export function screenOf(pathname: string): Screen | null {
  return recordOf(pathname, SCREEN_PAGES);
}

/** The window the panel listens on (the page's own). */
export interface HostWindow {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** The framed assistant's window, as the frame's `contentWindow` gives it. */
export interface FrameWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** A session id as the assistant makes it (a random UUID); anything else is not a hello. */
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isHello(data: unknown): data is { session: string } {
  if (typeof data !== 'object' || data === null) return false;
  const hello = data as Record<string, unknown>;
  return (
    hello.type === HELLO &&
    hello.v === SCREEN_CONTEXT_VERSION &&
    typeof hello.session === 'string' &&
    SESSION.test(hello.session)
  );
}

/**
 * Answers the framed assistant's hello and then tells it each screen change. A hello counts only
 * from the assistant's own origin and from the panel's frame (not another frame or window), and
 * screens are sent only to that origin, never to `*`. Each hello with a new session (the assistant
 * reloaded) starts the sequence again at 1, as the contract asks; a repeated hello of the same
 * session is answered with the current screen and the next number.
 */
export function createScreenHost({
  origin,
  win,
  frame,
  screen: initial,
}: {
  /** The assistant's origin (of AGENT_ASSISTANT_URL). */
  origin: string;
  win: HostWindow;
  /** The panel's frame window now (it changes when the frame is replaced), or null. */
  frame: () => FrameWindow | null;
  screen: Screen | null;
}) {
  let screen = initial;
  let session: string | null = null;
  let seq = 0;

  function send() {
    const target = frame();
    if (!session || !target) return;
    seq += 1;
    target.postMessage({ type: SCREEN, v: SCREEN_CONTEXT_VERSION, session, seq, screen }, origin);
  }

  function listener(event: MessageEvent) {
    if (event.origin !== origin) return;
    const target = frame();
    if (!target || event.source !== target) return;
    if (!isHello(event.data)) return;
    if (event.data.session !== session) {
      session = event.data.session;
      seq = 0;
    }
    send();
  }

  win.addEventListener('message', listener);

  return {
    /** The page changed: tells the assistant once it has said hello, and only on a change. */
    setScreen(next: Screen | null) {
      if (next === screen || (next && screen && next.kind === screen.kind && next.id === screen.id))
        return;
      screen = next;
      send();
    },
    stop() {
      win.removeEventListener('message', listener);
      session = null;
    },
  };
}
