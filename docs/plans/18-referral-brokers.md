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
- Each referrer gets a **customer code** `r_` + 8 characters `[a-z0-9]` (random, unique, kept on the partner,
  `partners.referral_code`, null for other kinds). It is what goes in his public links:
  `t.me/<bot>?start=r_k7m2x9qa` and `nolon.dev/?ref=r_k7m2x9qa`. Staff can issue a new code (the old one stops
  working; customers already linked stay linked).
- `customers.referred_by_partner_id` (nullable, FK to a `REFERRER` partner) and `customers.referred_at`.
- **Who sets it**, and when it is refused:
  1. **The bot**, on the customer's first capture: an optional `referral: { code }` beside `fields`. Nolon links
     only when this capture **created** the customer file and no other customer or profile already held the
     phone or the channel identity. An unknown, inactive or old code, a capture that found an existing customer,
     or a code on a later capture: ignored silently (the capture answers as without it, no new outcome).
  2. **Staff**, from the customer file, with `customers:update` and a written reason (audited): set, change or
     clear the broker. This is the owner's "only by my decision" path; the change does not move any commission
     already accrued.
  3. **The broker himself**, from his own screen (18-4): name and phone only. Refused when the phone already
     belongs to a customer (`CUSTOMER_EXISTS`, without saying whose).
- The customer file shows «جابه: المندوب فلان» to staff who can view customers.

## 4. Commission

### 4.1 The first paid shipment

- `CommissionRole` gains `REFERRER`, and `shipments` gains `referrer_id` (nullable, FK to a `REFERRER` partner)
  and `referrer_reason` (`FIRST_SHIPMENT` | `BROUGHT_IN_PERSON`), both null or both set.
- **When it is decided:** at the approval of the shipment's first customer invoice (since 13-4, the window taking
  the customer's cash; the `INVOICED` event). In that transaction, before the commission sync: if the shipment has
  no referrer yet, its customer has a broker, and no **other** shipment of that customer holds
  `referrer_reason = FIRST_SHIPMENT` and is not cancelled, the shipment gets the broker with `FIRST_SHIPMENT`.
  The customer row is locked (`FOR UPDATE`) first, so two invoices approved at the same moment cannot both be
  first.
- **Expiry (optional):** `partners.referral_window_days` (nullable, default null = no limit), edited on the
  partner screen. When set, the first shipment counts only if its invoice date is within that many days of
  `customers.referred_at`.
- A first shipment that is later **cancelled** gives its commission back (the existing sync reverses the slot),
  and the customer's next paid shipment becomes the first.
- Only the customer who **sends** counts (the shipment's customer), never the receiver.

### 4.2 A shipment the broker brings in person

- The window receipt body gains an optional `broughtByReferrerId` (a `REFERRER` partner, active). It sets the
  shipment's referrer with `BROUGHT_IN_PERSON`. The clerk picks from active referrers by name or phone.
- It works for any customer, the broker's own or not (the owner's rule is "he carried it"), and does not link the
  customer to him.
- If the shipment already has `FIRST_SHIPMENT` for the same broker, nothing changes. If it has another broker's
  `FIRST_SHIPMENT`, the receipt is refused (`REFERRER_ALREADY_SET`): one shipment, one broker commission.
- Staff with `shipments:update` can correct the referrer on a shipment with a reason (a wrong pick); the sync gives
  the commission to the right broker by difference, as for the consolidator today (`SHIPMENT_PARTNERS`).

### 4.3 Amount

- The referrer's **contracts** on the existing partner contracts screen: percentage of price or fixed per unit,
  per category or for every category, valid dates, approval. Default `accrual_event` for a referrer contract:
  `INVOICED` (paid). Nothing new to build here beyond allowing the kind.
- No contract on the day of the event: nothing accrues, and the existing hold says so on the shipment.

### 4.4 Posting and payment

- The REFERRER slot posts through rule 16 like the other roles: a cost and a payable to the broker's supplier.
  `ShipmentCommissionFacts.partners.REFERRER` is the shipment's `referrer_id`.
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

- When the REFERRER slot of a `FIRST_SHIPMENT` shipment first accrues a positive amount (an `ACCRUAL` row), the
  same transaction queues one notice: `REFERRER_FIRST_SHIPMENT_PAID` with `eventId`, `occurredAt`,
  `referrer: { channel: 'telegram', externalId }` (his live binding), `customerFirstName` (first word of the
  customer's name), `commission: { amount, currency, currencyNameAr, decimalPlaces }` (amount as a decimal
  string; name and places from the currencies table), and `shipmentRef` (the shipment number, for tracing).
- No binding, or the switch off: no notice is queued.
- The current outbox is per booking request (`request_id`, a sequence per request). Broker notices go in their
  own table, `cs_partner_notices` (same columns as `cs_outbox_events` without the request, plus `partner_id` and
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
  wins; a phone already held is refused on the broker screen; two first invoices at the same moment, one wins; a
  cancelled first shipment passes the first to the next; expiry; in-person on a shipment with another broker's
  first is refused; a broker user cannot read another broker's customers or commissions; link token expired,
  used, unknown, reused by the same subject; a subject bound to another partner; a notice not queued without a
  binding or with the switch off; the notice carries no phone and no full name.

## 9. Build, in order

| PR   | Content                                                                                                                                                                                        | Migration                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 18-1 | `REFERRER` partner kind, `referral_code`, `referral_window_days`, `customers.referred_by_partner_id/referred_at`, capture `referral`, staff set/clear with reason, «جابه» on the customer file | Additive (enum value, nullable columns, index)                                                     |
| 18-2 | `REFERRER` commission role, `shipments.referrer_id/referrer_reason`, first-shipment rule at invoice approval, broker at window receipt, correction                                             | Enum value on `commission_role` (a commission type): reviewer + owner OK + label if the check asks |
| 18-3 | Broker Telegram link (tokens, bindings, endpoint, partner screen), `cs_partner_notices`, notice on first shipment, switch                                                                      | Additive (new tables)                                                                              |
| 18-4 | Broker's own screen: `REFERRER_STAFF` role, add a customer, his customers and commissions                                                                                                      | Additive (enum value on roles) or none                                                             |
| 18-5 | Public site: read `?ref=`, keep it, send `ref` with the first chat message (site.tgz, owner deploys)                                                                                           | None                                                                                               |

Each PR goes to the reviewer thread; the agent project builds its side after 18-1 (capture) and 18-3 (link and
event) are on main and deployed. Every switch starts off; nothing is entered in production (owner rule,
2026-11-10).

## 10. Choices made ⭐ (the owner can change them)

- The first shipment is decided at invoice approval (paid), not at booking, so a cancelled booking never counts.
- A broker's customer link and his private Telegram link are different, so a notice never reaches a customer.
- In-person shipments earn for any customer, and need the clerk's pick at receipt.
- One broker commission per shipment.
- Expiry off by default; a setting per broker.
- Staff can change a customer's broker only with a written reason; it never moves commission already accrued.
