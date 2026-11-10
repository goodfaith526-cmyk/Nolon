# 18. Referral brokers: customers brought by a person, paid per shipment

The owner asked for this on 2026-11-10 («ابدا», 20:03, after the decisions below, 16:14 to 19:00). This plan is
the complete design; the build comes in section 9, each PR after this plan has the reviewer's OK. The bot side
(erp-agents) has its own plan, agreed in the same thread; its contract with Nolon is section 7.

## 1. The model in one page

A **referral broker** (مندوب، سمسار) is a person, usually a Sudanese with a wide social circle (family groups,
expatriate gatherings), who brings customers to Nolon. He is not an outlet: he has no counter and takes no cash.

| Rule (owner, 2026-11-10)                                                                                                                                                                           | Where                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| No commission for registering a customer. Registration alone earns nothing.                                                                                                                        | 3                     |
| The **first paid shipment** of a customer the broker registered earns him a commission, even if the customer booked alone, however long after (an optional expiry is a setting, empty by default). | 4.1                   |
| After that, a shipment earns him a commission **only when he brings it to the window in person**. The window clerk picks his name at goods receipt. If the customer comes alone, nothing.          | 4.2                   |
| The amount is flexible, changed from the screen: a percentage of the price or a fixed amount per category, per broker.                                                                             | 4.3 (existing screen) |
| A customer belongs to the **first** broker who registered him. A customer already in Nolon is never linked.                                                                                        | 3                     |
| The broker gets a message when his customer pays the first shipment.                                                                                                                               | 6                     |
| He is paid once a month from a statement; a return reduces it.                                                                                                                                     | 4.4 (existing)        |

Customers stay central (AGENTS.md rule 2 exception, plans 09d/09f): the link to a broker gives the broker no
access to the customer file and changes nothing about who can see the customer.

## 2. What already exists (reused, not rebuilt)

- Partners (`partners`, `PartnerKind`), partner contracts (`partner_contracts`: `PERCENT_OF_PRICE` or
  `FIXED_PER_UNIT`, per price category, valid dates, approval, `accrual_event`), and the screen for them
  (`PartnerContracts.tsx`).
- The commission sub-ledger (plan 07): `CommissionAccrualService.syncShipmentInTx` keeps one slot per
  `CommissionRole` per shipment equal to what the contract earns now, posting rule 16 by difference;
  `CommissionTriggers` call it from every write that can change it; holds; partner statements and settlement.
- The customer capture from the bot (`POST /cs/customer-profiles/capture`, `nolon.customer-identity/1`).
- The CS outbox and its worker (plan 09 section 5), and the signed receiver in erp-agents.
- The window desk goods receipt (plan 13).

## 3. Registering a customer for a broker

- `PartnerKind` gains `REFERRER`. A referrer partner is a person: name, phone, country, currency (of his
  commission), and the supplier its payable goes to, as for other partners.
- Each referrer gets a **customer code** `r_` + 8 characters `[a-z0-9]` (random). Codes live in a new table,
  `referral_codes(code PK, partner_id, created_at, retired_at)`, one live code per partner (unique partial index
  on `partner_id` where `retired_at` is null). A new table keeps the unique indexes off the existing `partners`
  table (F237-3) and keeps old codes recognizable. It is what goes in his public links:
  `t.me/<bot>?start=r_k7m2x9qa` and `nolon.dev/?ref=r_k7m2x9qa`. Staff can issue a new code (the old one is
  retired and stops linking; customers already linked stay linked).
- `customers.referred_by_partner_id` (nullable, FK to a `REFERRER` partner), `customers.referred_at`, and
  `customers.referral_first_shipment_id` (nullable, FK to `shipments`): the shipment that consumed the customer's
  "first" (4.1). All three nullable, no CHECK on the existing table.
- **Who sets it**, and when it is refused:
  1. **The bot**, on the customer's first capture: an optional `referral: { code }` beside `fields`. Nolon links
     only when this capture **created** the customer file and no other customer or profile already held the
     phone or the channel identity. An unknown, inactive or old code, a capture that found an existing customer,
     or a code on a later capture: ignored silently (the capture answers as without it, no new outcome).
     A website chat with no signed identity creates no customer file at capture, so its `ref` is dropped; the
     customer can still be linked by staff (F237-5).
  2. **Staff**, from the customer file, with `customers:update` and a written reason (audited): set, change or
     clear the broker. This is the owner's "only by my decision" path; the change does not move any commission
     already accrued. A change sets `referred_at` to the time of the change (the expiry window restarts for the
     new broker); it never touches `referral_first_shipment_id`, so a "first" already consumed stays consumed
     and the new broker earns only on what he brings in person (F237-4).
  3. **The broker himself**, from his own screen (18-4): name and phone only. Refused when the phone already
     belongs to a customer (`CUSTOMER_EXISTS`, without saying whose). Because that answer tells whether a phone is
     a Nolon customer, each broker has at most 20 refused attempts a day (then `TOO_MANY_ATTEMPTS` until the next
     day in his branch), and every refusal is audited with the phone hashed (F237-5).
- The customer file shows «جابه: المندوب فلان» to staff who can view customers.

## 4. Commission

### 4.1 Two facts, one decision (independent of the order of receipt and payment)

At the window, goods receipt and payment (`collect`, which approves the invoice since 13-4) are separate steps,
in either order (F237-1). So a shipment keeps two separate facts, and the commission slot is **derived** from
them by one function, whatever happened first:

- New table `shipment_referrals(shipment_id PK FK, brought_by_partner_id, referrer_id, referrer_reason,
first_for_customer_id, updated_at)`, with a CHECK that `referrer_id` and `referrer_reason`
  (`FIRST_SHIPMENT` | `BROUGHT_IN_PERSON`) are both null or both set. A new table, so its CHECK and FKs are
  additive (F237-3); nothing is added to `shipments`.
  - `brought_by_partner_id`: the broker the clerk picked at receipt (4.3). Always kept, even when he does not get
    the commission.
  - `first_for_customer_id`: set when this shipment consumed its customer's "first".
  - `referrer_id`, `referrer_reason`: the commission slot, the output of `decideReferrerInTx`.
- `CommissionRole` gains `REFERRER`; `ShipmentCommissionFacts.partners.REFERRER` is `shipment_referrals.referrer_id`.

### 4.2 The first paid shipment

- **"First" is consumed at the approval of the shipment's first customer invoice** (the `INVOICED` event, the
  window taking the cash), whether or not the shipment already has a broker picked at receipt. In that
  transaction: if the customer has a broker, `referral_first_shipment_id` is null (or points to a cancelled
  shipment), and the expiry allows it, then `customers.referral_first_shipment_id` = this shipment and
  `shipment_referrals.first_for_customer_id` = the customer. Then `decideReferrerInTx` runs, then the commission
  sync.
- **`decideReferrerInTx`** (the only writer of the slot), called at receipt, at first invoice approval, at
  cancellation and at a staff correction:
  1. this shipment consumed its customer's first → the customer's broker, `FIRST_SHIPMENT`;
  2. else a broker was picked at receipt → that broker, `BROUGHT_IN_PERSON`;
  3. else no slot.
- **Both on one shipment:** same broker → `FIRST_SHIPMENT` (counts as both, one commission). Different brokers
  → ⭐ the customer's broker gets it (`FIRST_SHIPMENT`), because the owner's rule gives the first paid shipment to
  whoever registered the customer; the carrier stays recorded in `brought_by_partner_id`, earns nothing on it, and
  the first is consumed either way. The owner can flip this precedence; it is one line in `decideReferrerInTx`.
- **Expiry (optional):** `partners.referral_window_days` (nullable, default null = no limit; a nullable column,
  no index), edited on the partner screen. When set, the first is consumed only if the invoice date is within
  that many days of `customers.referred_at`; past it, the customer's first is never paid (the shipment can still
  be in person).
- **Cancelled first:** cancelling the shipment that consumed the first frees it (`referral_first_shipment_id`
  pointing to a cancelled shipment counts as free; the cancellation clears it in the same transaction) and
  re-runs `decideReferrerInTx` on it, so the sync reverses the commission. The **next shipment whose first
  invoice is approved after that** becomes first; shipments already approved before are not re-examined (F237-4).
- **Fully credited (returned) first:** it keeps the first. Its commission nets to zero through the credit note
  (plan 07), and no later shipment becomes first. ⭐ A return is not a new chance at the first (F237-4).
- Only the customer who **sends** counts (the shipment's customer), never the receiver.
- **Lock order (F237-2).** In `collectOnce` the locks are taken as today (window, invoice, booking, shipment), and
  the **customer row is the last lock**, taken only when the customer has a broker (read without a lock, then
  `FOR UPDATE` and re-read). Cancellation takes it after the shipment too. The capture and profile writes in
  `customers.service.ts` lock the customer and never take a window, invoice, booking or shipment lock after it,
  so no cycle exists; 18-2 adds a test that runs a capture and an approval for the same customer at once, and
  a code comment at each lock naming this order.

### 4.3 A shipment the broker brings in person

- The window receipt body gains an optional `broughtByReferrerId` (a `REFERRER` partner, active). It sets
  `shipment_referrals.brought_by_partner_id` and runs `decideReferrerInTx`. The clerk picks from active referrers
  by name or phone.
- It works for any customer, the broker's own or not (the owner's rule is "he carried it"), and does not link the
  customer to him. It never refuses: precedence (4.2) decides who is paid.
- Staff with `shipments:update` can correct the picked broker with a reason (a wrong pick); `decideReferrerInTx`
  runs and the sync moves the commission by difference, as for the consolidator today (`SHIPMENT_PARTNERS`).
- Tests for both orders: receipt then payment, payment then receipt, each with the same broker, a different
  broker, and no broker at receipt.

### 4.4 Amount

- The referrer's **contracts** on the existing partner contracts screen: percentage of price or fixed per unit,
  per category or for every category, valid dates, approval. Default `accrual_event` for a referrer contract:
  `INVOICED` (paid). Nothing new to build here beyond allowing the kind.
- No contract on the day of the event: nothing accrues, and the existing hold says so on the shipment.

### 4.5 Posting and payment

- The REFERRER slot posts through rule 16 like the other roles: a cost and a payable to the broker's supplier.
- The partner statement and settlement are unchanged: monthly, after approval, credit notes reduce it.

## 5. The broker's Telegram account

So that a message about a customer and money reaches the broker and nobody else, the broker links his Telegram
account through a **private link** that is not his customer link.

- `referrer_link_tokens(id, partner_id, token_hash, expires_at, used_at, used_by_binding_id, created_by_id,
created_at)`: staff issue one from the partner screen; the token `ag_` + 32 characters `[A-Za-z0-9]` is shown
  once (as a link to copy), only its SHA-256 is kept, valid 7 days, single use. Issuing a new one revokes the
  open ones.
- `partner_channel_bindings(id, partner_id, channel, subject_id, created_at, revoked_at)`: one live binding per
  partner and channel, and one per channel subject (unique partial indexes).
- `POST /api/v1/cs/referrers/link`, bot key with the new scope `cs:referrers:link`. Body:
  `{ token, identity }`, `identity` the same signed sender assertion as in customer-identity. Replies: 200
  `{ status: 'LINKED', firstName }`; 404 `REFERRER_LINK_UNKNOWN`; 409 `REFERRER_LINK_USED`; 410
  `REFERRER_LINK_EXPIRED`. The same subject opening its own used link again: 200 `LINKED`. A subject already bound
  to another partner: 409 `REFERRER_LINK_USED` (no detail).
- Staff can revoke a binding from the partner screen.

## 6. The message to the broker

- When the REFERRER slot of a `FIRST_SHIPMENT` shipment accrues a positive amount (an `ACCRUAL` row), the
  same transaction queues one notice: `REFERRER_FIRST_SHIPMENT_PAID` with `eventId`, `occurredAt`,
  `referrer: { channel: 'telegram', externalId }` (his live binding), `customerFirstName` (first word of the
  customer's name), `commission: { amount, currency, currencyNameAr, decimalPlaces }` (amount as a decimal
  string; name and places from the currencies table), and `shipmentRef` (the shipment number, for tracing).
- No binding, or the switch off: no notice is queued.
- **At most one notice per (shipment, broker):** a unique key on `cs_partner_notices(type, shipment_id,
partner_id)`; the insert uses `ON CONFLICT DO NOTHING`, so a later positive re-accrual (after a credit note and a
  new invoice) sends nothing (F237-5).
- The current outbox is per booking request (`request_id`, a sequence per request). Broker notices go in their
  own table, `cs_partner_notices` (same columns as `cs_outbox_events` without the request, plus `partner_id`,
  `shipment_id` and
  `payload`), sent by the same worker to the same approved endpoint of the bot's key, signed the same way.
- The receiver answers 200 for a valid event with `{ delivered: true }` or
  `{ delivered: false, reason: 'NO_CHAT' | 'BLOCKED' | 'NOTICES_OFF' }`; Nolon records the reason and does not
  retry. Any other answer is retried as other events are.
- Switch `CS_REFERRER_NOTICES_ENABLED`, off by default (plan 12 owner rule for every notice).
- Only the first shipment sends a message (owner, 19:00). In-person shipments show on his statement only.

## 7. The contract with erp-agents (agreed 2026-11-10, 19:52 and 19:55)

| Item                           | Value                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| Customer code                  | `r_` + 8 `[a-z0-9]`; campaign codes stay `c_`                                                |
| Capture field                  | `referral: { code }`, optional, beside `fields`, first capture only; contract stays `/1`     |
| Website                        | Nolon's page reads `?ref=`, keeps it in the browser, sends `ref` with the first chat message |
| Broker link                    | `ag_` + 32, single use, 7 days; `POST /api/v1/cs/referrers/link` as in section 5             |
| Event                          | `REFERRER_FIRST_SHIPMENT_PAID` as in section 6                                               |
| Texts (Modern Standard Arabic) | written by the bot, approved by the owner: linked, link invalid, first shipment paid         |

The capture field is optional, so the bot can send it only after Nolon has it: 18-1 merges and deploys first.

## 8. Permissions and rules that keep it safe

- Referrer partners and their contracts: the existing `partners` permissions. Linking a customer by staff:
  `customers:update`. Picking a broker at the window: the window desk permission that receives.
- The broker's own screen (18-4) is a new role `REFERRER_STAFF` tied to one referrer partner (as Outlet Staff are
  tied to an outlet): he sees only the customers he registered (name and masked phone), their shipment count, and
  his own commissions and statements. He sees no shipment detail, price, invoice or other broker. No export.
- Every write is audited (who linked whom, the reason). Commission rows only come from the sync (rule 16).
- Tests (AGENTS.md rule 7), including negatives: a code on an existing customer is ignored; two brokers, first
  wins; a phone already held is refused on the broker screen, rate-limited and audited; two first invoices at
  the same moment, one wins; receipt then payment and payment then receipt, with the same broker, another broker
  and none (same result either order); a cancelled first frees it for the next approved shipment only; a fully
  credited first keeps it; a broker change resets `referred_at` and keeps a consumed first; expiry; a capture and
  an approval for the same customer at once (no deadlock); a notice queued once per shipment and broker; a broker
  user cannot read another broker's customers or commissions; link token expired,
  used, unknown, reused by the same subject; a subject bound to another partner; a notice not queued without a
  binding or with the switch off; the notice carries no phone and no full name.

## 9. Build, in order

| PR   | Content                                                                                                                                                                                                                    | Migration                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 18-1 | `REFERRER` partner kind, `referral_codes`, `referral_window_days`, `customers.referred_by_partner_id/referred_at/referral_first_shipment_id`, capture `referral`, staff set/clear with reason, «جابه» on the customer file | Additive: enum value, new table with its unique indexes, nullable columns and FKs on existing tables, no CHECK or unique index on them |
| 18-2 | `REFERRER` commission role, `shipment_referrals`, `decideReferrerInTx`, first consumed at invoice approval, broker at window receipt, cancellation and correction, lock order                                              | New table (additive) + enum value on `commission_role` (a commission sub-ledger type): owner OK + label                                |
| 18-3 | Broker Telegram link (tokens, bindings, endpoint, partner screen), `cs_partner_notices`, notice on first shipment, switch                                                                                                  | Additive (new tables)                                                                                                                  |
| 18-4 | Broker's own screen: `REFERRER_STAFF` role, add a customer, his customers and commissions                                                                                                                                  | Additive (enum value on roles) or none                                                                                                 |
| 18-5 | Public site: read `?ref=`, keep it, send `ref` with the first chat message (site.tgz, owner deploys)                                                                                                                       | None                                                                                                                                   |

Each PR goes to the reviewer thread; the agent project builds its side after 18-1 (capture) and 18-3 (link and
event) are on main and deployed. Every switch starts off; nothing is entered in production (owner rule,
2026-11-10).

## 10. Choices made ⭐ (the owner can change them)

- The first shipment is decided at invoice approval (paid), not at booking, so a cancelled booking never counts.
- A broker's customer link and his private Telegram link are different, so a notice never reaches a customer.
- In-person shipments earn for any customer, and need the clerk's pick at receipt.
- One broker commission per shipment. When the customer's first and another broker's in-person pick fall on one
  shipment, the customer's broker is paid (the carrier is recorded, not paid).
- A fully credited (returned) first shipment keeps the first; only a cancellation frees it.
- Expiry off by default; a setting per broker.
- Staff can change a customer's broker only with a written reason; it never moves commission already accrued.
