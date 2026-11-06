# Plan 14: the customer's statement after proof of identity

Request from the agent project (erp-agents), 2026-11-05. The owner decided the bot keeps in memory only the booking
requests not yet delivered. For anything older (delivered, cancelled, rejected, expired) the customer asks for a
**statement**, and NOLON produces it after the customer proves who they are.

Today a customer token (`POST /cs/customer-tokens`, plan 04 N1) is issued only from a number the channel verified, and
that is WhatsApp only. `/cs/me/shipments`, `/cs/me/shipments/:number` and `/cs/me/invoices` read with it.

Three things are asked:

1. One statement per customer for a date range: data plus a NOLON-branded PDF the bot sends.
2. Proof of identity for the channels other than WhatsApp (Telegram, website chat), ending in a customer token.
3. Every statement read in the access log (`cs_access_events`), as every `/cs/me` read.

Everything new is behind switches that are off by default. Migrations are additive only. Customers are central (plan
09f): nothing here ties a customer to a branch. The documents in the statement stay branch-owned and are limited to the
key's branches, as every `/cs/me` read today.

## 1. Proof of identity per channel

| Channel      | Proof                                                                        | In this plan |
| ------------ | ---------------------------------------------------------------------------- | ------------ |
| WhatsApp     | The sender's number, verified by WhatsApp (today)                            | unchanged    |
| Telegram ⭐  | The customer shares **their own** Telegram contact (Telegram-verified phone) | 14-1         |
| Website chat | None in NOLON; the bot offers one-tap links to continue on WhatsApp/Telegram | no change    |

### Why not a code sent by NOLON (OTP)

- NOLON sends no WhatsApp, SMS or email today. A WhatsApp message NOLON starts (outside the customer's 24-hour window)
  needs a Meta-approved authentication template, a sender account and a cost per message; SMS needs a provider for
  Sudan, Saudi Arabia and the UAE. That is a new outside dependency and new cost for a proof Telegram already gives.
- Telegram verifies every account's phone number at sign-up. When a user taps the bot's "share my number" button,
  Telegram sends a contact whose `user_id` is the sender's own id: that number is proven to belong to the sender, as
  strongly as a WhatsApp sender's number. Plan 08 already carries it as `phoneEvidence.kind = TELEGRAM_OWN_CONTACT`,
  inside the signed channel assertion, and the schema already refuses evidence whose `contactUserId` is not the sender.
- The website chat has no channel identity at all (plan 08 knows WHATSAPP and TELEGRAM only). A code typed into an
  anonymous page proves only that someone can read the customer's phone; it adds a sender, cost and a phishing surface.
  The bot sends the customer a `wa.me` / `t.me` link to the same bot, and the statement works there.
- An OTP (WhatsApp template or SMS) stays a later plan if the owner wants the website chat itself to show statements.

### 14-1: a customer token from a Telegram own contact

- `POST /cs/customer-tokens` accepts the **signed channel assertion** of plan 08 (`X-Nolon-Channel-Assertion`,
  `X-Nolon-Channel-Context`, `Idempotency-Key`), checked by `CustomerIdentityAuth.verify` exactly as today (HMAC over
  method, path, body hash and context; 5-minute window; the key's configured Telegram account only).
- With an assertion, the body is
  `{ phone, customerNumber?, phoneEvidence: { kind: 'TELEGRAM_OWN_CONTACT', contactUserId, value } }` and NOLON requires
  all of: `context.channel = 'TELEGRAM'`, `phoneEvidence.contactUserId = context.subjectId`, `phoneEvidence.value =
phone`. Anything else is `401 INVALID_CHANNEL_ASSERTION`. A body with `phoneEvidence` and no assertion is `400`.
- Without an assertion the endpoint is exactly today's (WhatsApp).
- From there it is the same match as WhatsApp: same limiters (per key and phone, per key), same `none` / `choose` /
  `token`, same grants (`CUSTOMER_PHONE` unverified-phone rule included), same `grantVersion`, same guard rechecks on
  every read. Level stays `L1`.
- The token remembers its channel and sender: new columns `cs_customer_tokens.channel varchar(20) NOT NULL DEFAULT
'whatsapp'` and `sender_hash char(64) NULL`, set for WhatsApp tokens only (F206-5): `sha256('whatsapp:' + canon(phone))` where
  `canon` keeps the digits and prefixes `+` (+E.164). Both additive. The hash is what 14-2 uses to find the WhatsApp
  requests this sender made. The same `canon` is applied to `phone` and `phoneEvidence.value` before they are compared
  and matched. The access-log rows of the token's reads carry the token's channel instead of the fixed
  `'whatsapp'`; the token request's own row carries the channel it came from.
- Switch `CS_TELEGRAM_TOKENS_ENABLED` (default false). Off: an assertion on this route is `503
TELEGRAM_TOKENS_UNAVAILABLE` and nothing is issued; WhatsApp is unaffected.
- **Tests (integration, negative first):** switch off = 503 and no token row; bad HMAC = 401; WhatsApp assertion with
  Telegram evidence = 401; evidence of another user (`contactUserId` ≠ `subjectId`) = 401; `value` ≠ `phone` = 401; a
  key whose configuration has no such Telegram account = 403; a phone matching nobody = `none` and counts in the limiter;
  a phone matching one customer = token with `channel = 'telegram'`, and its `/cs/me/shipments` read logs
  `channel = 'telegram'`; a phone typed by someone else (`phoneUnverified`) grants nothing, as today.

## 2. 14-2: the statement as data

`GET /cs/me/statement?from=YYYY-MM-DD&to=YYYY-MM-DD` with a customer token (any channel).

- **Range:** both optional. `to` defaults to today, `from` to `to` minus 6 months. `from ≤ to`, at most 366 days, and
  `to` not after today; otherwise `400 INVALID_RANGE`. Dates are calendar dates in the company's customer-day
  timezone, `Africa/Khartoum` (the existing `CUSTOMER_DAY_TIMEZONE` of customer reports) (F206-8): "today" is today
  there; a timestamp (request and booking `created_at`) is in the range when `startOfDayIn(from) ≤ t <
startOfDayIn(to + 1 day)`, so `to` includes its whole day; `invoice_date` (a date column) is compared as a date.
  Boundary tests use 23:59 and 00:00 Khartoum time.
- **The customer comes from the token only.** Documents are limited to the key's branches, as `/cs/me/*` today.
  Requests use `servedBy` (`branch_id`, else `allowed_branch_ids` for a request awaiting routing), exactly as
  `GET /cs/booking-requests` (F206-6). Test: an unrouted request whose candidates are all outside the key's branches is
  absent; one with a candidate inside is present.
- **Content** (each section newest first, at most 200 rows, with `count` and `truncated: true` when cut):
  - `requests`: the bot booking requests **the token holder owns** (F206-1) in the range, **of every status**:
    `reference`, `createdAt`, origin and destination names (`{ ar, en }`), the goods (category name, quantity and unit),
    `status` (the same states as `GET /cs/booking-requests`) and `bookingNumber` when approved. A request is the token
    holder's when one of these verified links holds, and only then:
    1. `customer_id` = the token's customer (the request was made with a customer token of that customer);
    2. `profile_id` = the token customer's profile (made under a signed channel identity bound to that profile, plan 08);
    3. **WhatsApp only** (F206-5): `sender_channel = 'whatsapp'`, the token's channel is WhatsApp, and
       `sha256('whatsapp:' + canon(sender_id))` = the token's `sender_hash`. A WhatsApp sender id is the number
       WhatsApp verified, stored as `+<digits>` or `<digits>`; `canon` makes both one form. Telegram requests match
       through links 1 and 2 only: a request saved under a signed Telegram assertion always has `profile_id` (link 2),
       while a key-vouched Telegram `sender.id` or a `tel:<typed digits>` id is not a proof and never matches.
       Regressions: a WhatsApp request stored as `249…` and one as `+249…` both match a token for `+249…`; a Telegram
       request with `tel:<same digits>` does not; a Telegram request with the same unsigned `sender.id` as the token's
       subject does not.
  - **Request owner is not booking customer.** A website-chat request (`instant_customer_id` from a typed phone, no
    profile, no token), a request where the customer is only the receiver or the "other sender", or any request linked
    only by a phone someone typed, is **not** in `requests`, even after its booking was approved for this customer.
    Its approved booking still appears in `bookings` below, because the booking's customer is the token's customer.
    What stays excluded until staff (profile link) or a channel proof resolves it: website-chat requests not approved,
    and requests where this customer is receiver or other sender. Regression: a website request with
    `instant_customer_id` = the customer and a cancelled one are absent from `requests`; the approved one is absent
    from `requests` and present in `bookings`; a WhatsApp request by the same verified number is present.
  - `bookings`: the bookings whose **customer** is the token's customer, in the range, of every status (a bot approval's `DRAFT` booking included):
    `number`, `createdAt`, origin and destination, `cargoDescription`, `status`, and its `shipment` (`number`, the
    customer stage of plan 09-2, `deliveredAt` or null). No costs, no prices.
  - `invoices`: one object `{ rows, count, truncated, totals }`. `rows`: the customer's invoices in the range as
    `/cs/me/invoices` shows them (approved, from `cs_invoices`): `number`, `shipmentNumber`, `invoiceDate`, `dueDate`, `currency`, `total`, `paid`, `credited`, `balance` (decimal
    strings). Draft (proforma) invoices are not in it.
  - `invoices.totals` per currency (F206-2), **inside** the invoices object so one mask covers it (F206-3): `count`, `total`, `paid`, `credited`, `balance` over **every** invoice of the
    filtered period, computed in SQL **before** the row cap, in the same read-only `REPEATABLE READ` transaction as the
    rows, so totals and rows are one snapshot. Each section also carries `count` (all matching rows) next to
    `truncated`.
  - `customer`: `number` and `label` only; `period`: `{ from, to }`; `generatedAt`.
- **Invoices at L1: an explicit exception to plan 04 N3 (F206-4).** `/cs/me/invoices` needs L2 (an email code, N3).
  The statement gives invoices at **L1**, because the owner asked (2026-11-05, the agent project's request the owner
  pasted) for the statement with its invoices after proof of identity, and the proof here is the customer's own number
  proven by the channel (WhatsApp sender, Telegram own contact). The exception covers the statement only;
  `/cs/me/invoices` stays L2. Test: the same L1 token that gets the statement's invoices gets `403 L2_REQUIRED` on
  `/cs/me/invoices`. The `invoices` section is filled for a token on the customer's **own** number (`CUSTOMER_PHONE`,
  `CUSTOMER_WHATSAPP`). For an authorized person (`CONTACT_PHONE`) it is
  `null` with `invoicesHidden: 'CONTACT'`: they may ask about shipments, not money. `null` hides **everything**
  invoice-derived: rows, `count`, `truncated` and every per-currency total; the invoice queries are not even run for
  that grant, and the PDF has no invoices section, totals or count (F206-3). Regression: a contact's token, JSON and
  PDF (renderer faked, HTML inspected), on a customer with unpaid invoices, returns no invoice number, amount,
  currency total or invoice count. `/cs/me/invoices` is unchanged (it
  still needs L2).
- **Access log:** one `cs_access_events` row per read, route `GET /cs/me/statement`, outcome `OK`, `INVALID_RANGE` or
  `UNAVAILABLE`; channel = the token's channel. Never the dates or any value.
- **Switch** `CS_STATEMENT_ENABLED` (default false). Off: `503 STATEMENT_UNAVAILABLE` (logged `UNAVAILABLE`).
- **Tests:** switch off = 503 and a log row; no token = 401; expired = 401 TOKEN_EXPIRED; another customer's request,
  booking and invoice never appear; a branch the key does not serve never appears; a document just outside the range is
  left out, one on each boundary is in; 367 days, `from > to`, a future `to`, a bad date = 400; a contact's token =
  `invoices: null`; amounts are strings and the per-currency totals are exact (Decimal); every read writes one log row;
  201 rows = 200 and `truncated: true`; 201 invoices whose only unpaid one is the omitted
  oldest: `totals.balance` still shows that balance.

## 3. 14-3: the statement as a PDF

`GET /cs/me/statement/pdf?from&to&lang=ar|en` with the same token, the same checks, the same data (one service builds
both), `lang` defaulting to the customer's preferred locale, else `ar`.

- **Renderer (plan 09 section 7, ⭐ (a)):** Gotenberg (Chromium in its own container) on the internal Docker network
  only, no egress, started with `--chromium-deny-list=^(?!file:///tmp/).*` (Gotenberg must still load its own `file:///tmp/…/index.html`;
  everything else is denied, and data: URIs are not network fetches) and `--chromium-disable-javascript=true` (F206-7).
  The internal network with no egress stays the real guard. One shared `PdfService` in the API (reused later by the
  waybill, plan 13-5): at most 2 renders at a time, 20-second timeout, HTML ≤ 512 KB, PDF ≤ 5 MB, answer must start
  with `%PDF-`. `PDF_RENDERER_URL` (optional env); unset = `503 PDF_UNAVAILABLE`, the JSON statement still works.
- **Template in the API:** self-contained HTML (A4, RTL for Arabic), every value escaped before HTML, NOLON's logo
  (`apps/web/src/assets/brand/logo-ar.webp` / `logo-en.webp`, unchanged) and the IBM Plex Sans Arabic font (OFL, as the
  web app) embedded as data URIs; no external URL. Header: logo, "Statement / كشف حساب", customer number and label,
  period, generated at. When a section is truncated the PDF shows, above it, "Showing the latest 200 of N; totals
  cover all N — ask for a shorter period for the rest" (Arabic and English). Sections as in 14-2, amounts in a fixed-width figure font aligned to the end, per-currency
  totals. Footer: NOLON's name and the fixed note that the statement is for information.
- **Answer:** `application/pdf`, `Content-Disposition: attachment; filename="statement-<customer>-<from>-<to>.pdf"`,
  `Cache-Control: no-store`. Nothing is stored. The bot downloads it with the token from its server and uploads it to the
  chat as a document (never a link to the customer or the model), as plan 09 section 7.
- **Deploy:** a `gotenberg` service in `deploy/staging` and `deploy/production` compose files, pinned image version,
  internal network only, memory limit; `PDF_RENDERER_URL=http://gotenberg:3000` for the API. Disk and memory are measured
  on staging before production.
- **Access log:** route `GET /cs/me/statement/pdf`, outcomes as 14-2 plus `PDF_FAILED`.
- **Tests:** a truncated section shows the notice in the PDF. Unit: every customer-entered text with `<script>` comes out as text; the HTML holds no `http` URL; Arabic
  is `dir="rtl"`. Integration (renderer faked): the same negative cases as 14-2; renderer down = 503 PDF_UNAVAILABLE
  logged; a non-PDF answer = 503; one real render on staging (Arabic RTL readable) before the switch goes on.

## 4. Build order, migrations, agent compatibility

| PR   | Content                                  | Migration                                              | Switch                                      |
| ---- | ---------------------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| 14-1 | Telegram token                           | additive (`cs_customer_tokens.channel`, `sender_hash`) | `CS_TELEGRAM_TOKENS_ENABLED`                |
| 14-2 | Statement data                           | none                                                   | `CS_STATEMENT_ENABLED`                      |
| 14-3 | Statement PDF + Gotenberg + `PdfService` | none                                                   | `CS_STATEMENT_ENABLED` + `PDF_RENDERER_URL` |

Nothing existing changes shape: new routes, one new optional way into an existing route, and a channel column with a
default. The agent keeps working as it is. When a PR merges, the agent project gets a paste note (contract, errors,
what to switch on) under `/mnt/project-files/agent/agent-notes/`. A switch goes on only after the agent side is
deployed, on staging and production together.

## 5. Decisions (⭐ chosen, recorded in the owner's decisions file)

1. Telegram proof = the customer's own shared contact, not a code; website chat = continue on WhatsApp/Telegram.
2. Default range 6 months, at most 366 days.
3. Invoices in the statement at L1 for the customer's own number (exception to plan 04 N3, statement only); an authorized person sees requests and shipments only.
4. The PDF is rendered on request and never stored.
