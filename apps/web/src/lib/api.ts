/**
 * Browser calls to the NOLON API. The web app only renders and calls the API; every rule and
 * permission check happens there (AGENTS.md rule 5).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The invalid fields a 400 names, as request paths (`items.0.weightKg`); empty otherwise. */
    readonly fields: readonly string[] = [],
    /**
     * For a broken rule (on those fields, or on the whole request): its reason (the API's text),
     * its code and the values its message names (`shipment`, `container`), if any.
     */
    readonly reason: string | null = null,
    readonly code: string | null = null,
    readonly params: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}

export async function api<T = void>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    let message = res.statusText;
    let fields: string[] = [];
    let reason: string | null = null;
    let code: string | null = null;
    const params: Record<string, string> = {};
    try {
      const data = (await res.json()) as {
        message?: unknown;
        fields?: unknown;
        code?: unknown;
        params?: unknown;
      };
      if (typeof data.message === 'string') message = data.message;
      // A request that fails validation is answered with the list of its invalid fields; a
      // broken rule with its reason in `message` and the fields it is about in `fields`.
      if (Array.isArray(data.message)) {
        fields = data.message.filter((f): f is string => typeof f === 'string');
        message = fields.join(', ');
      } else if (Array.isArray(data.fields)) {
        fields = data.fields.filter((f): f is string => typeof f === 'string');
        reason = message;
        if (typeof data.code === 'string') code = data.code;
        if (typeof data.params === 'object' && data.params !== null) {
          for (const [key, value] of Object.entries(data.params)) {
            if (typeof value === 'string') params[key] = value;
          }
        }
      }
    } catch {
      // Body was not JSON; keep the status text.
    }
    throw new ApiError(res.status, message, fields, reason, code, params);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A text resource of the API (an SVG QR code), or null when it cannot be read. */
export async function apiText(path: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/v1${path}`, { credentials: 'same-origin' });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}
