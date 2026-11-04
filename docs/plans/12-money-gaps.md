# 12. Closing the money gaps in the operations journey

The owner asked on 2026-11-04 for a review of the whole journey, from a bot request or a staff booking to
delivery and payment. The review is `/mnt/project-files/nolon/reviews/رحلة-العمليات-من-الحجز-للدفع-2026-11-04.md`,
23 steps, against main 473e97d. The operations are sound. The weak part is the link between operations
and money. The owner approved fixing every gap the review found (2026-11-04 04:53), with one rule:
**a notice to the customer is never automatic only. It sits behind a switch that can be turned on and off.**

This is the plan. The build comes in the PRs listed in section 9, each one after this plan has a Codex OK.

## 0. Gaps found (main 473e97d)

| #   | Gap                                                                                                                                                                                                                                                                                                                         | Where                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| G1  | Confirming a booking makes the shipment, never the invoice. The invoice is a manual draft, then a manual approval. Until then it is not on the statement, because the statement reads posted entries only.                                                                                                                  | `bookings.service.ts:671-687`, `invoices.service.ts:562`, `customer-statement.service.ts:21` |
| G2  | The price approved for a bot request (`cs_booking_requests.approved_total`, the accepted estimate) is never read by billing. The invoice is priced from a quotation (a bot booking has none) or from the rate card **on the invoice date**, in the customer's or branch's currency, which may not be the approved currency. | `booking-review.service.ts:566-806`, `invoices.service.ts:619-800`, `invoice-suggestion.ts`  |
| G3  | The credit limit is stored and shown, and never checked. Rule ب6 (plan 06) is planned and not built.                                                                                                                                                                                                                        | `customers.service.ts:102-127`, `docs/plans/06-client-decisions-v2.md` ب6                    |
| G4  | Goods release and proof of delivery never look at invoices or payment. A shipment can be handed over unbilled or unpaid.                                                                                                                                                                                                    | `warehouse-movements.service.ts:375-440`, `transport/pod.service.ts`                         |
| G5  | Customs fees are recorded as amounts only. Storage has an alert and no charge. Neither reaches an invoice.                                                                                                                                                                                                                  | `customs.service.ts:40-48`, `packages/shared/src/alerts.ts`                                  |
| G6  | Approving a bot request makes a **draft** booking, while the customer already reads «booked». Nothing reminds staff to confirm it.                                                                                                                                                                                          | `booking-review.service.ts:744`, `:797`                                                      |
| G7  | A shipment can be set DELIVERED by hand without a POD (only `pod:create` is needed). The POD records no ID of the person who received the goods.                                                                                                                                                                            | `state-machine.ts:179`, `ProofOfDelivery` model                                              |
| G8  | The customer cannot send a transfer receipt through the bot. The payment instructions are text only.                                                                                                                                                                                                                        | `payment-instructions.service.ts`                                                            |
| G9  | A booking or shipment that has been paid cannot be cancelled (#113), and there is no refund or advance path.                                                                                                                                                                                                                | plan Q, #113                                                                                 |
| G10 | No alert for a draft bot booking, a confirmed shipment with no approved invoice, or a delivered shipment that is not closed.                                                                                                                                                                                                | `packages/shared/src/alerts.ts:10-17`                                                        |

## 1. The agreed terms are pinned on the booking (G2; Codex F190-2)

**⭐ When a price is agreed, the booking keeps a fingerprint of exactly what was priced. The automatic path
(section 2) uses the agreed price only while the booking still matches that fingerprint. Any change makes the
invoice a draft for staff, never an approved invoice at an old price.**

- **Bot request → APPROVED quotation.** In `approve`, in the same transaction, after `insertInTx`,
  `QuotationsService.insertApprovedInTx` makes a quotation with status `APPROVED`, `source = 'BOT_REQUEST'` and
  `cs_request_id`. Its currency is the approved one (`input.pricing.currency`, or `estimateCurrency` for an
  estimate). It has one FREIGHT line per priced request item: the item's approved category, approved quantity,
  the card's unit, unit price and minimum, and a line total equal to that item's `approvedTotal`. Each line
  carries `booking_item_id`, the booking line made from that item (the `lineOf` map already built in
  `approve`). An estimated request gets one line, quantity 1, total = the accepted `estimateAmount`. That line
  has `booking_item_id` null and `covers_all_items = true`. The booking's `quotation_id` is set to it.
- **The fingerprint.** `bookings.agreed_terms_hash` (char 64) and `bookings.agreed_terms_version` (int) are
  written in the same transaction as the agreement. That is bot approval, or `createFromQuotation` for a staff
  quotation. The hash is SHA-256 of a canonical JSON (`agreedTerms/1`) with these fields:
  - origin, destination, mode, load type, cargo type and the sorted services;
  - the quotation id and its `updatedAt`, plus the bot request's `estimateVersion` for an estimate;
  - every booking line, sorted by line number, with its id, price category, quantity, unit, and the `isOther`
    description. A line changed, added or dropped changes the hash, even inside a category the quotation
    already has.
- **At confirmation** the hash is computed again from the booking as it now is (`agreedTermsOf`, a pure
  function with unit tests). If it is equal, the agreed prices are used line by line through `booking_item_id`.
  The estimate line is used whole. If it differs or is missing, there is no agreed price for the automatic
  path. The auto-invoice is then a DRAFT priced by today's derivation, with `auto_note =
'AGREED_TERMS_CHANGED'` (section 2). Staff reprice it, or the customer accepts a new estimate.
- The manual suggestion (`/invoice-drafts/suggest`) keeps today's `quotationDrift` behaviour, because a human
  reviews it. The fingerprint governs only automatic approval.
- Several FREIGHT lines on one quotation are new. `systemPrice` (a staff-entered line checked against the
  quotation) matches by `booking_item_id` when the quotation has bound lines, and otherwise refuses
  `QUOTED_PRICE_SEVERAL` as today.
- A bot quotation is never edited or sent: those routes refuse `source = 'BOT_REQUEST'` with 409
  `QUOTATION_FROM_REQUEST`. It prints like any quotation.
- **Migration (additive, no accounting table):** enum `quotation_source` (`STAFF`, `BOT_REQUEST`).
  `quotations.source` NOT NULL DEFAULT `'STAFF'`. `quotations.cs_request_id` uuid NULL with a foreign key and a
  unique index. `quotation_lines.booking_item_id` uuid NULL with a foreign key. `quotation_lines.covers_all_items`
  boolean NOT NULL DEFAULT false. `bookings.agreed_terms_hash` char(64) NULL. `bookings.agreed_terms_version`
  int NULL.
- **Tests:** these regressions are required:
  - one barrel priced, the booking line edited to two barrels: the result is a draft, not one barrel approved;
  - a second line added in the same category: draft;
  - a line dropped: draft;
  - services changed: draft;
  - an estimate whose items changed after acceptance: draft;
  - an estimate unchanged: approved at exactly the estimate;
  - several items unchanged: each line exactly equals its `approvedTotal`, in the approved currency.
- **Agent:** none. The agent reads the request, not the quotation.

## 2. The invoice is made when the booking is confirmed (G1; Codex F190-1, F190-3)

**⭐ On confirmation, NOLON always makes the shipment's MAIN invoice as a DRAFT. It approves it in the same
transaction only through a narrow, server-only rule. If anything blocks approval, the draft stays, finance
gets an alert, and nothing is posted.**

### 2.1 Authorization (F190-1)

The owner asked for this in their own words on 2026-11-04 04:39: «الفاتورة مفروض تتعمل تلقائيا اول ما الحجز
يتأكد.. وتظهر في الاستيتمنت». On 04:53 they approved this plan's direction. That is the authorization for one
exception: an invoice approved by a system rule, not by a person holding `customer_invoices:approve`. The
exception is limited as follows.

- **Only these sources may be auto-approved:**
  - (i) Every line comes from an agreed price whose fingerprint still matches (section 1). That is a bot
    quotation, or a staff quotation with status APPROVED that its approver signed.
  - (ii) Every line comes from approved rate cards, **and** the confirming user holds
    `customer_invoices:approve` in the booking's branch. In this case quantities typed by staff decide the
    amount, so the person's own right is needed.
  - Anything else is a DRAFT.
- **Server-only.** `autoApproveOnConfirmInTx(tx, initiator, derivation)` is not exported to any controller.
  It approves only the invoice that the same call inserted in the same transaction, from the derivation it
  holds. It never takes an invoice id, so it cannot approve a manual or older draft. No request body can set
  `approval_source`. A unit test pins that no route reaches it except the three confirm callers (2.3).
- **Audit.** These fields are recorded:
  - `approval_source = 'AUTO_ON_CONFIRM'`;
  - `auto_rule = 'AGREED_PRICE' | 'RATE_CARD_WITH_RIGHT'`;
  - `approvedById` = NULL for rule (i), or the confirming user for rule (ii);
  - `auto_initiated_by_id` = the confirming user, always.

  The audit log gets `INVOICE_AUTO_APPROVED` with both ids and the agreed-terms hash. A database check
  requires this: an approved invoice has `approvedById` set, or `approval_source = 'AUTO_ON_CONFIRM'` with
  `auto_initiated_by_id` set. The invoice page shows «اعتُمدت تلقائياً عند تأكيد الحجز بواسطة …».

- **Switch:** `BILLING_AUTO_APPROVE_ENABLED`, **default `false`**, validated in `env.ts`. While it is off,
  confirmation still makes the DRAFT and raises the alert, so the gap is visible from day one. The owner turns
  it on in `switches.env` after the negative permission tests are green. Creating the draft has no switch: it
  posts nothing.
- **Negative tests:**
  - a confirmer without `customer_invoices:approve`, with a rate-card price: DRAFT;
  - the same confirmer with a matching agreed price: approved, with `approvedById` NULL and the initiator
    recorded;
  - a confirmer with the right in another branch only: DRAFT;
  - the switch off: DRAFT;
  - a manual draft that already exists for the shipment is never approved by confirmation;
  - no route body can set `approval_source` (strict schema 400).

### 2.2 What is made

- `deriveForShipmentInTx` runs the same derivation as the suggestion, read in the transaction, with the
  section 1 fingerprint rule. The invoice date is today in the branch's time zone, and the kind is MAIN (#151).
- If no line can be priced, no invoice is made. Otherwise a DRAFT is made with the priced lines and an
  `auto_note` naming what blocks approval: `PRICE_INCOMPLETE`, `AGREED_TERMS_CHANGED`, `NO_APPROVE_RIGHT`,
  `PERIOD_CLOSED`, `CREDIT_LIMIT_EXCEEDED`, `CREDIT_LIMIT_NO_RATE`, `NO_FX_RATE` or `SWITCH_OFF`. The alert
  `SHIPMENT_NOT_INVOICED` (section 7) lists it.

### 2.3 Transaction boundary and lock order (F190-3)

Plan 06 puts the customer's credit advisory lock last in the transaction. That stays. The automatic approval
is wrapped in a PostgreSQL savepoint, so a refusal removes every posted effect and keeps the booking and the
draft.

1. The caller does its own writes:
   - confirm: the booking row lock, booking CONFIRMED, shipment;
   - container booking: the container writes;
   - bot approval: the request, the quotation, the outbox rows.
2. The DRAFT invoice is inserted, under the shipment's lock, as #151 orders it: the shipment, then the invoice.
3. Plan 06's confirm check runs here: the balance **before** this invoice, which the draft does not count.
   It happens under `credit:<customer>` only if step 4 is skipped. Otherwise it is folded into step 4's
   single statement as `balance_before`.
4. If the rule of 2.1 allows approval: `SAVEPOINT auto_invoice`. Then, inside it:
   - the period check;
   - numbering (`number_sequences` row);
   - the journal through `autoJournal.customerInvoiceApproved`;
   - commissions;
   - the `invoice.issued` outbox row, if its switch is on (section 8).

   Then, **last**: `pg_advisory_xact_lock(credit:<customer>)` and plan 06's single statement, which gives
   `balance_before` and `balance_after`.
   - `balance_before > limit`: the whole transaction is refused with 409 `CREDIT_LIMIT_EXCEEDED`. This is plan
     06's confirm rule. Nothing is kept.
   - `balance_after > limit`, or no FX rate: `ROLLBACK TO SAVEPOINT auto_invoice`. In PostgreSQL this
     undoes the number, journal, commission and outbox rows of the subtransaction, and releases its locks,
     the advisory lock included. Then the draft's `auto_note` is set. The confirmation stands.
   - Otherwise: `RELEASE SAVEPOINT`, and the transaction commits.
   - A coded refusal inside the savepoint (closed period, missing FX for `totalUsd`) also rolls back to the
     savepoint, with its note. Any other error propagates and fails the whole transaction (fail closed).

5. Step 4 is the **last** step of every caller's transaction. Nothing is written after it except the draft
   note in the fallback case, which takes no new lock. So `confirmInTx` no longer calls billing. Each caller
   calls `billing.autoInvoiceLastInTx` as its final statement:
   - `BookingsService.confirm`;
   - the container booking in `ConsolidationsService`;
   - the bot `approve` (section 4).

   A test per caller asserts the order.

- The savepoint runs as raw SQL through the interactive transaction (`tx.$executeRaw\`SAVEPOINT ...\``).
PR 12-2 includes an integration test proving that Prisma's transaction keeps working after `ROLLBACK TO
  SAVEPOINT`.
- **Integration tests:**
  - failure after posting (`balance_after` over the limit): no journal, no number used, no commission, no
    outbox row; the booking is CONFIRMED and the draft is noted;
  - `balance_before` over the limit: nothing kept;
  - missing FX;
  - closed period;
  - two concurrent confirms for one customer, whose sum is over the limit: one approved and one draft, no
    deadlock;
  - a confirm racing a receipt cancel;
  - the container caller and the bot caller.

### 2.4 Other points

- **Order:** 12-2 is built only after 12-1 (ب6), so the credit check exists before anything is auto-approved.
- **Migration:** these columns are added to `customer_invoices`:
  - `approval_source`, enum `invoice_approval_source` (`MANUAL`, `AUTO_ON_CONFIRM`), NOT NULL DEFAULT
    `'MANUAL'`;
  - `auto_rule`, an enum, NULL;
  - `auto_note`, varchar(40), NULL;
  - `auto_initiated_by_id`, uuid NULL, with a foreign key;
  - the check constraint above.

  `approved_by_id` is already nullable, so it does not change. `customer_invoices` is an accounting table, so
  this needs the owner's label (rule 4).

- **Statement:** unchanged. It shows posted entries, which now exist from confirmation once the switch is on.
- **Agent:** confirming a container-booking draft from the assistant returns the same shape. No new field.

## 3. Credit limit (G3), then payment before handover (G4; Codex F190-4, F190-5)

- **ب6 is built exactly as plan 06 wrote it (PR 12-1).** Plan 06 gives a null limit no check, and that
  stays for confirm and approve.
- **Handover gate (new, PR 12-3).** It covers:
  - a goods release from a warehouse whose `location_id` is the shipment's destination;
  - a POD;
  - a hand-set PARTIALLY_DELIVERED or DELIVERED.

  Releases at the origin and loading moves are not gated. The check runs **at the handover's own transaction
  boundary, as its last step**: after the movement or POD rows, under `credit:<customer>`, in one statement in
  plan 06's style. It reads the current state, never an earlier approval.
  - **(a) Billed:** the shipment has a **live MAIN** invoice that is APPROVED. Live means not cancelled and
    not fully credited. A draft MAIN (an auto draft included), a cancelled one, or a fully credited one does
    not count. An ADDITIONAL invoice never counts, paid or not. Otherwise: 409 `HANDOVER_NOT_INVOICED`.
  - **(b) Paid or within credit:** it depends on the customer's limit as it is at that moment.
    - **No limit (null) or limit 0 (cash):** the sum left to pay on all the shipment's live approved
      invoices (MAIN and ADDITIONAL), after credits, must be 0. Otherwise: 409 `HANDOVER_UNPAID` {shipment,
      balance, currency}. An unapplied advance does not count until it is applied to the invoice.
    - **Positive limit:** the customer's current open balance, computed by plan 06's single statement, must
      be ≤ the limit. Otherwise: 409 `HANDOVER_OVER_LIMIT` {customer, balance, limit, currency}. Missing FX:
      409 `CREDIT_LIMIT_NO_RATE`.

  So a receipt cancelled after approval, a reversed application, or a limit lowered later all block the
  handover, because the check is current.

- **Override:** the permission `handover:override_payment`, and a reason of at least 10 characters. It
  overrides (a) and (b), and also covers a shipment carried free (no MAIN on purpose). It is recorded on the
  movement or POD (`payment_override_reason`, `payment_override_by_id`) and in the audit log. No role gets it
  by seed. The Administrator grants it on the permissions screen.
- **Locks:** the shipment lock first (as releases and PODs take it today), then the credit advisory lock last.
  Receipts, applications and credit notes take no credit lock (plan 06), and the single statement reads one
  snapshot.
- **Migration (additive):** `payment_override_reason` text NULL and `payment_override_by_id` uuid NULL, on
  `warehouse_movements` and `proofs_of_delivery`.
- **Tests:**
  - a paid ADDITIONAL with a draft MAIN: 409;
  - a paid ADDITIONAL with a cancelled or fully credited MAIN: 409;
  - limit 0, unpaid: 409;
  - limit 0, an advance applied and then the receipt cancelled: 409;
  - a positive limit lowered under the balance: 409;
  - missing FX: 409;
  - fully paid: 200;
  - override without the permission: 403;
  - override without a reason: 400;
  - override: 200, audited;
  - an origin release: never gated;
  - a handover racing a receipt cancel.
- **Agent:** none. The agent writes no release and no POD.

## 4. Approving a bot request confirms its booking (G6)

**⭐ One staff decision, one result.** `approve` calls `bookings.confirmInTx` right after `insertInTx` and
the quotation of section 1, in the same transaction. It then writes the request rows and the outbox
(`request.approved`). As its **last** step it calls `billing.autoInvoiceLastInTx` (section 2.3). So approval
makes the booking CONFIRMED, its shipment, and its invoice: approved if section 2.1 allows it, else a draft.
Every confirm check runs: cargo completeness, and ب6 on the balance before. A refusal rolls the whole approval
back with the confirm code, and the request stays PENDING. A refused auto-approval only leaves the draft.

- The request's stage stays `BOOKED`, which is now true.
- The receiver customer step of plan 09e (another thread) runs in this same transaction. Whichever PR lands
  second rebases onto the first.
- **Switch:** `CS_APPROVE_CONFIRMS_ENABLED`, default `false` until the owner turns it on staging. While it is
  off, approval behaves as today and the alert `BOOKING_DRAFT_FROM_REQUEST` (section 7) covers the gap.
- **Agent:** the booking status the bot reads moves from DRAFT to CONFIRMED earlier. The request's events are
  unchanged (`request.approved`, then shipment stage notices). A note for the agent project says the shipment
  now exists at approval.

## 5. Customs and storage reach the invoice (G5)

- **Customs fees** on the shipment's customs file are offered as lines of the «فاتورة خدمات إضافية»
  (#151): charge type `CUSTOMS`, amount and currency as recorded, one line per fee. They are never
  auto-approved, because staff enter the amounts. A fee already billed on a live invoice of the shipment is
  not offered again (rule 3 of #151). The alert `SHIPMENT_NOT_INVOICED` also counts unbilled customs fees.
- **Storage:** after the free days, a daily charge from an approved rate card (charge type `STORAGE`, unit
  per day, per CBM or per package as the card says), computed from GRN to release per warehouse. It is
  offered on the additional services invoice when the goods leave, or on demand. If no card exists, nothing
  is offered and the existing alert stays. Free days are a field on the card (`free_days` int NULL, additive).
  **Built last** (section 9) and shown to the owner before it is built, because it prices something new.

## 6. Delivery proof and the receiver (G7)

- A hand-set DELIVERED or PARTIALLY_DELIVERED with no POD needs a reason, and that reason is recorded on the
  event. A POD stays the normal path.
- The POD gets optional `recipient_id_type` and `recipient_id_number` (additive, nullable), shown on the
  delivery note. They are optional now and can become required later by a switch.

## 7. Alerts (G10)

New fixed kinds in `ALERT_KINDS`, each with its days set in `alert_settings` (default shown):

| Kind                         | Shows                                                                             | Permission               | Default days |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------ | ------------ |
| `BOOKING_DRAFT_FROM_REQUEST` | A booking made by approving a bot request, still DRAFT                            | `bookings:view`          | 1            |
| `SHIPMENT_NOT_INVOICED`      | A confirmed shipment with no approved MAIN invoice, or with unbilled customs fees | `customer_invoices:view` | 0            |
| `DELIVERED_NOT_CLOSED`       | DELIVERED and not CLOSED                                                          | `shipments:view`         | 3            |

**Migration (additive):** new enum values, and seed rows in `alert_settings` (only if that table needs a row
per kind; otherwise the defaults stay in code).

## 8. Customer notices: always behind a switch (owner rule)

Every new notice to the customer is an outbox event, written in the transaction that causes it
(`CsEventsService.emitInTx`). It is **written only when its switch is on**. Every switch is default `false`,
is validated in `env.ts`, and is set only in `switches.env`.

| Switch                       | Event                 | When                                                                       |
| ---------------------------- | --------------------- | -------------------------------------------------------------------------- |
| `CS_NOTIFY_INVOICE_ENABLED`  | `invoice.issued`      | An invoice of a bot booking is approved: number, total, currency, due date |
| `CS_NOTIFY_DUE_ENABLED`      | `invoice.due`         | Once, on the due date, for a balance left (from the alerts sweep)          |
| `CS_NOTIFY_PAYMENT_ENABLED`  | `payment.received`    | A receipt applied to an invoice of a bot booking                           |
| `CS_PAYMENT_RECEIPT_ENABLED` | (route, not a notice) | `POST /cs/booking-requests/:id/payment-proof` (section 8a)                 |

The existing shipment stage notices are not changed by this plan.

The new event types also need the agent to accept them, so the switches stay off until the erp-agents
compat PR is merged and deployed (compat rule).

### 8a. Transfer receipt from the bot (G8)

`POST /cs/booking-requests/:id/payment-proof` takes a photo (the same limits as request photos), amount,
currency and a transfer reference. It requires owner proof, the same as cancel. It stores a
**payment proof** in a new branch-owned table, `cs_payment_proofs`, with status PENDING, ACCEPTED or REJECTED.
The existing `receipt_drafts` table is not used, because it belongs to staff assistant sessions. Finance sees
the pending proofs. Accepting one opens the normal receipt form, prefilled, and the receipt is written by the
existing `ReceiptsService.create` with its request key; the proof links to that receipt. Rejecting one needs a
reason. Nothing is posted until a finance user saves the receipt (erp-agents rule 3). Without the switch the
route returns 404.

## 9. Order of PRs (each is one push when complete, Codex reviews, all checks green)

| PR      | Content                                                                                                     | Depends on                        | Migration                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------- |
| 12-1    | ب6 credit limit, exactly as plan 06                                                                         | #189 merged                       | none                                                          |
| 12-2    | Section 1 (agreed terms) + section 2 (auto draft, auto-approve behind its switch) + `SHIPMENT_NOT_INVOICED` | 12-1, #151 merged                 | quotations/bookings: additive. customer_invoices: owner label |
| 12-3    | Section 3 handover gate                                                                                     | 12-1, #151                        | additive (override columns)                                   |
| 12-4    | Section 4 approve = confirm, behind its switch + `BOOKING_DRAFT_FROM_REQUEST`                               | 12-2, and ordered with 09e        | none                                                          |
| 12-5    | Section 5 customs fees on the additional invoice + section 6 + `DELIVERED_NOT_CLOSED`                       | #151                              | additive                                                      |
| 12-6    | Section 8 notices and 8a payment proofs, all switches off                                                   | erp-agents compat PR merges first | additive (new table `cs_payment_proofs`)                      |
| 12-7    | Section 5 storage charges                                                                                   | the owner sees the rule first     | additive                                                      |
| (later) | G9: cancelling after payment = full credit note, the paid amount stays as the customer's advance            | own plan                          | -                                                             |

## 10. Tests (rule 7)

Each PR carries:

- unit tests for its rules;
- integration tests against PostgreSQL, including the negative cases:
  - wrong branch, missing permission;
  - the per-section negative cases listed in sections 1, 2.1, 2.3 and 3;
  - auto-approval turned off by its switch (a draft is still made);
  - a bot request with several items and with an estimate, whose invoice equals the approved total and
    currency;
  - a handover with no invoice, unpaid, a customer with a limit, an override without a reason, an override
    without the permission;
  - races: a confirm against a receipt cancel, and two confirms for one customer;
  - every notice switch off: no outbox row is written.
