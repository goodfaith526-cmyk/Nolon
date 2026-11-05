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
'whatsapp'` and `sender_hash char(64) NULL` = `sha256('<channel>:<subject>')` (WhatsApp: the verified number;
  Telegram: the signed `subjectId`). Both additive. The hash is what 14-2 uses to find the requests this sender made. The access-log rows of the token's reads carry the token's channel instead of the fixed
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
  `to` not after today; otherwise `400 INVALID_RANGE`. Dates are calendar dates, compared on the document's own date
  (request: created; booking: created; invoice: `invoice_date`).
- **The customer comes from the token only.** Documents are limited to the key's branches, as `/cs/me/*` today.
- **Content** (each section newest first, at most 200 rows, with `count` and `truncated: true` when cut):
  - `requests`: the bot booking requests **the token holder owns** (F206-1) in the range, **of every status**:
    `reference`, `createdAt`, origin and destination names (`{ ar, en }`), the goods (category name, quantity and unit),
    `status` (the same states as `GET /cs/booking-requests`) and `bookingNumber` when approved. A request is the token
    holder's when one of these verified links holds, and only then:
    1. `customer_id` = the token's customer (the request was made with a customer token of that customer);
    2. `profile_id` = the token customer's profile (made under a signed channel identity bound to that profile, plan 08);
    3. the request's own sender is the token's sender: `sender_channel` = the token's channel and
       `sha256(channel:sender_id)` = the token's new `sender_hash` (14-1: for WhatsApp the verified number, for
       Telegram the signed `subjectId`). That is the same channel identity, proven both times by the channel.
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
  - `invoices`: the customer's invoices in the range as `/cs/me/invoices` shows them (approved, from `cs_invoices`):
    `number`, `shipmentNumber`, `invoiceDate`, `dueDate`, `currency`, `total`, `paid`, `credited`, `balance` (decimal
    strings). Draft (proforma) invoices are not in it.
  - `totals` per currency (F206-2): `count`, `total`, `paid`, `credited`, `balance` over **every** invoice of the
    filtered period, computed in SQL **before** the row cap, in the same read-only `REPEATABLE READ` transaction as the
    rows, so totals and rows are one snapshot. Each section also carries `count` (all matching rows) next to
    `truncated`.
  - `customer`: `number` and `label` only; `period`: `{ from, to }`; `generatedAt`.
- **Invoices and the grant (⭐ owner request 2026-11-05):** the `invoices` section is filled for a token on the
  customer's **own** number (`CUSTOMER_PHONE`, `CUSTOMER_WHATSAPP`). For an authorized person (`CONTACT_PHONE`) it is
  `null` with `invoicesHidden: 'CONTACT'`: they may ask about shipments, not money. `/cs/me/invoices` is unchanged (it
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
  only, no egress, started with `--chromium-deny-list=.*`. One shared `PdfService` in the API (reused later by the
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
3. Invoices in the statement for the customer's own number; an authorized person sees requests and shipments only.
4. The PDF is rendered on request and never stored.
