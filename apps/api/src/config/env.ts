import { z } from 'zod';

/** Compose passes `${VAR:-}` as an empty string; treat that as not set. */
function emptyAsUnset<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema);
}

/** An https URL (http only for localhost, for development). */
function httpsUrl() {
  return z
    .string()
    .url()
    .refine(
      (value) => {
        // Runs even when .url() already failed: a value that is not a URL is just rejected.
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return (
          url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
        );
      },
      { message: 'must be an https URL (http only for localhost)' },
    );
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  /**
   * Public address of the web app, used in tracking links and QR codes. Empty: the first
   * CORS origin (the web app's own address in every deployment so far).
   */
  PUBLIC_WEB_URL: emptyAsUnset(z.string().url().optional()),
  /**
   * Where staff open the AI assistant (the platform's staff screen, e.g.
   * https://pilot.example.com/?tenant=nolon). Empty: no assistant button. HTTPS only, except
   * localhost for development.
   */
  AGENT_ASSISTANT_URL: emptyAsUnset(httpsUrl().optional()),
  /**
   * The bookings agent's admin panel, exactly as the agent gives it (e.g.
   * https://assistant.example.com/agent-admin.html?tenant=nolon&signin=erp). Empty: no menu item.
   * Shown only to holders of agent_admin:view. HTTPS only, except localhost for development.
   */
  AGENT_ADMIN_URL: emptyAsUnset(httpsUrl().optional()),
  /**
   * `true`: the assistant opens as a panel inside NOLON's pages (a frame of AGENT_ASSISTANT_URL)
   * instead of a new tab. Only once the assistant allows this NOLON address to frame it (its
   * TENANT_ORIGINS hostOrigin) and shares its site, or the panel stays blank. Ignored without
   * AGENT_ASSISTANT_URL.
   */
  AGENT_ASSISTANT_PANEL: emptyAsUnset(
    z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  ),
  /**
   * `true`: the Outlet Staff role may be assigned on the users screen and API (business model plan
   * 4.2). Off until the owner opens it; the role and its isolation are built and tested either way.
   */
  OUTLET_STAFF_ASSIGNABLE: emptyAsUnset(
    z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  ),
  /** Plan 08: opt-in unified profile capture. Never enabled by a deployment default. */
  CS_CUSTOMER_IDENTITY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Plan 09d section 4a: a profile's first message makes its one central customer. Off by default.
   */
  CS_CUSTOMER_IDENTITY_ACCOUNT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** The branch code a first-message customer is registered in when the key has several. */
  CS_CUSTOMER_IDENTITY_HOME_BRANCH: emptyAsUnset(
    z
      .string()
      .regex(/^[A-Z]{2,10}$/)
      .optional(),
  ),
  CS_CUSTOMER_IDENTITY_COMPANY_ID: emptyAsUnset(
    // Stable namespace; never inferred from an incoming message.
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .optional(),
  ),
  /** Secret JSON map keyed by API client UUID: { secret, accounts: [{channel, channelAccountId}] }. */
  CS_CUSTOMER_IDENTITY_CLIENTS: emptyAsUnset(z.string().default('{}')),
  CS_CUSTOMER_FOLLOWUP_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  CS_CUSTOMER_BOOKING_IDENTITY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Plan 09 section 2: a customer cancels a bot's booking request. Off until the bot's connector
   * accepts the cancelled state (consumer first, plan 09 section 9).
   */
  CS_BOOKING_CANCEL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Plan 09 section 12: staff estimates for items outside the standard categories, and the
   * customer's acceptance. Off (default) until the bot accepts the estimated state (consumer
   * first, plan 09 section 9); photo upload works either way.
   */
  CS_ESTIMATES_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * The owner's instant account (2026-11-03): a signed bot request for a known branch makes or
   * reuses the profile's branch account when it is saved. Off: the account waits for approval, as
   * before.
   */
  CS_INSTANT_CUSTOMER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Plan 09 section 5 (N-C5): the HMAC secret notices are signed with (the receiver's
   * CS_WEBHOOK_SECRET). Unset: no endpoint can be approved and nothing is sent.
   */
  CS_WEBHOOK_SECRET: emptyAsUnset(z.string().min(32).max(256).optional()),
  /** Comma-separated host names an endpoint may use (https, port 443). Empty: none. */
  CS_WEBHOOK_ALLOWED_HOSTS: emptyAsUnset(
    z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter((h) => h !== ''),
      )
      .pipe(
        z.array(
          z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
        ),
      ),
  ),
  /** `true`: this process sends the outbox. Off (default): notices wait in the outbox. */
  CS_WEBHOOK_WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Absolute lifetime of a sign-in session. */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  /** Lifetime of a delegated token of the staff AI assistant (agent-auth). */
  AGENT_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(10).default(10),
  /**
   * Exact number of reverse proxies in front of the API (Express `trust proxy`). The client IP is
   * taken from X-Forwarded-For only through these hops. 0 ignores the header.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** Per-IP failed sign-in limit. Off only while the proxies cannot pass the real client IP. */
  LOGIN_IP_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * Days a new quotation is offered as valid for: the form's valid-until starts at the branch's
   * today plus this (GET /quotations/defaults). A suggestion only; the person may change it.
   */
  QUOTATION_VALIDITY_DAYS: emptyAsUnset(z.coerce.number().int().min(1).max(365).default(30)),
  /** Hours between runs of the draft retention purge (drafts/draft-retention.service.ts); 0 = off. */
  DRAFT_PURGE_EVERY_HOURS: z.coerce.number().int().min(0).max(168).default(6),
  /** Seed only: the first Administrator, created if missing. Never committed. Empty = unset. */
  SEED_ADMIN_EMAIL: emptyAsUnset(z.string().email().optional()),
  SEED_ADMIN_PASSWORD: emptyAsUnset(z.string().min(12).max(200).optional()),
  /** Seed only: fail when no active Administrator exists after seeding (staging sets it). */
  SEED_REQUIRE_ADMIN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type AppEnv = z.infer<typeof envSchema>;

export const APP_ENV = Symbol('APP_ENV');

/** Parses process.env once at startup and fails fast with a readable message. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}
