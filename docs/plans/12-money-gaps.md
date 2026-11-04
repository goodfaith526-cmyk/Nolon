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

## 1. The agreed price lives on the booking (G2)

**⭐ An approved bot request becomes an APPROVED quotation linked to its booking.** Billing already reads
agreed prices from a booking's quotation (`agreedPrices`, `quotationDrift`, the currency rule in
`invoiceCurrency`), so the bot path reuses that machinery instead of adding a second price source.

- In `approve`, in the same transaction, after `insertInTx`: `QuotationsService.insertApprovedInTx(tx, user, ...)`.
  It makes a quotation with status `APPROVED`, `source = 'BOT_REQUEST'` and `cs_request_id`, in the approved
  currency (`input.pricing.currency`, or `estimateCurrency` for an estimate). It has one FREIGHT line per
  priced item: price category, quantity, the card's unit price and minimum, and a line total equal to that
  item's `approvedTotal`. An estimated request gets one line, quantity 1, the estimate amount. The booking's
  `quotation_id` is set to it.
- Several FREIGHT lines on one quotation are new. `systemPrice` refuses `QUOTED_PRICE_SEVERAL` today. The
  quotation path of `deriveForShipment` copies quotation lines one by one, so it already handles them.
  `systemPrice` matches a staff line to its quotation line by `(chargeTypeCode, priceCategoryCode)` when the
  charge has several lines, and refuses only when that pair is still ambiguous.
- The quotation is not shown as a sales quotation to edit: it is born APPROVED, and the routes that edit or
  send a quotation refuse `source = 'BOT_REQUEST'` with 409 `QUOTATION_FROM_REQUEST`. It prints like any quotation.
- **A staff booking with no quotation:** no snapshot is needed. Section 2 makes its invoice at confirmation,
  so the rate card used is the one valid on the confirmation day, the day the booking was agreed.
- **Migration (additive):** `quotations.source` enum `quotation_source` (`STAFF`, `BOT_REQUEST`) NOT NULL DEFAULT
  `'STAFF'`, and `quotations.cs_request_id` uuid NULL with a foreign key to `cs_booking_requests`, plus a unique index.
- **Agent:** none. The agent reads the request, not the quotation.

## 2. The invoice is made when the booking is confirmed (G1)

**⭐ When a booking is confirmed and its price is complete, the invoice is made and approved in the same
transaction. If the price is not complete, a draft invoice is made with whatever can be priced, and finance
gets an alert.**

- `confirmInTx` calls `InvoicesService.autoInvoiceInTx(tx, user, shipmentId)` after `createForBooking`. It
  runs on every confirm path: `POST /bookings/:id/confirm`, a container booking, and the bot approval of
  section 4.
- `autoInvoiceInTx` runs `deriveForShipmentInTx`, the same derivation as the suggestion, read in the
  transaction. The invoice date is today in the branch's time zone, and the kind is MAIN (#151).
  - **Complete:** no `unresolved`, every line `FILL`, total > 0. The invoice is inserted and approved through
    the existing approve body (numbering, `autoJournal.customerInvoiceApproved`, commissions), extracted to
    `approveInTx`. The posting comes only from the auto-journal rules service.
  - **Not complete:** if at least one line is priced, a DRAFT invoice is made with the priced lines plus an
    `auto_note` that says why it is incomplete. If nothing can be priced, no invoice is made. Either way the
    alert `SHIPMENT_NOT_INVOICED` (section 7) shows it to finance.
  - **The date is in a closed period**, or **the credit limit (section 3) would be passed by this invoice:**
    a DRAFT is made with the reason. The confirmation itself is never rolled back by the invoice step. The
    shipment exists either way, and money is never posted past a rule.
- **Who approves.** The prices come only from an approved quotation or an approved rate card. The person who
  confirms enters no amount, so no human judgement goes into the posting. ⭐ The invoice is approved as
  `approvedById = the confirming user` with `approval_source = 'AUTO_ON_CONFIRM'`, and the audit log shows it,
  even when that user does not hold `customer_invoices:approve`. Editing an amount afterwards still needs the
  usual rights, through a credit note. (The alternative was approving only for users who hold the
  permission. That would leave most bookings unbilled, which is the gap itself.)
- **Switch:** `BILLING_AUTO_INVOICE_ENABLED`, default `true`, validated in `env.ts`. It is an emergency off
  for staff-side billing. It is not a customer notice.
- **Migration (additive):** `customer_invoices.approval_source` enum `invoice_approval_source` (`MANUAL`,
  `AUTO_ON_CONFIRM`) NOT NULL DEFAULT `'MANUAL'`, and `customer_invoices.auto_note` text NULL. Rule 4
  flags them because `customer_invoices` is an accounting table, so they need the owner's label, as #151 did.
  They are constant-default and nullable columns only.
- **Statement:** unchanged. It still shows posted entries, which now exist from confirmation.
- **Agent:** the response of confirming a container-booking draft from the assistant is the same. No new field.

## 3. Credit limit (G3), then payment before handover (G4)

- **ب6 is built exactly as plan 06 wrote it.** The open balance is computed in one statement under the
  advisory lock `credit:<customer>`. It is checked on confirm (the balance before) and on approve (the
  balance after). The codes are 409 `CREDIT_LIMIT_EXCEEDED` and `CREDIT_LIMIT_NO_RATE`. Accepting a draft
  is never refused. The auto-invoice of section 2 uses the same check. If the invoice would pass the limit,
  it stays a draft, as section 2 says.
- **Handover gate (new).** It applies to a goods release from a warehouse whose `location_id` is the
  shipment's destination, to a POD, and to a hand-set PARTIALLY_DELIVERED or DELIVERED. These are refused
  when either of the following holds, unless the user overrides:
  - (a) the shipment has no approved invoice and no no-charge reason. Code: 409 `HANDOVER_NOT_INVOICED`.
  - (b) the customer has **no credit limit** (a cash customer), and the shipment's approved invoices still
    have a balance. Code: 409 `HANDOVER_UNPAID` {shipment, balance, currency}.

  A customer with a limit passes (b), because ب6 already capped their debt.

- **Override:** the new permission `handover:override_payment`, with a reason of 10 or more characters. It is
  recorded on the movement or POD (`payment_override_reason`, `payment_override_by_id`) and in the audit log.
  No role gets it by seed. The Administrator grants it on the permissions screen, so there is no seed migration.
- **Releases at the origin and loading moves** are not gated: (a) and (b) apply only at the destination.
- **Migration (additive):** two nullable columns on `warehouse_movements` and on `proofs_of_delivery`.
- **Agent:** none. The agent writes no release and no POD.

## 4. Approving a bot request confirms its booking (G6)

**⭐ One staff decision, one result.** `approve` calls `bookings.confirmInTx` right after `insertInTx`, in the
same transaction. So approval makes the booking CONFIRMED, its shipment and its invoice (section 2). Every
confirm check runs: cargo completeness, and ب6 on the balance before. A refusal rolls the approval back,
with the confirm code, and the request stays PENDING.

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

| PR      | Content                                                                                                                                   | Depends on                        | Migration                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| 12-1    | Section 1 (bot price → quotation) + section 2 (auto-invoice) + `SHIPMENT_NOT_INVOICED`                                                    | #189, #151 merged                 | quotations: additive. customer_invoices columns: owner label (accounting table) |
| 12-2    | ب6 credit limit (plan 06) + section 3 handover gate                                                                                       | 12-1                              | additive (override columns)                                                     |
| 12-3    | Section 4 approve = confirm, behind its switch + `BOOKING_DRAFT_FROM_REQUEST`                                                             | 12-1, and ordered with 09e        | none                                                                            |
| 12-4    | Section 5 customs fees on the additional invoice + section 6 + `DELIVERED_NOT_CLOSED`                                                     | #151                              | additive                                                                        |
| 12-5    | Section 8 notices and 8a payment proofs, all switches off                                                                                 | erp-agents compat PR merges first | additive (new table `cs_payment_proofs`)                                        |
| 12-6    | Section 5 storage charges                                                                                                                 | the owner sees the rule first     | additive                                                                        |
| (later) | G9: cancelling after payment means a full credit note, and the paid amount stays as the customer's advance (no cash refund by the system) | own plan                          | -                                                                               |

## 10. Tests (rule 7)

Each PR carries:

- unit tests for its rules;
- integration tests against PostgreSQL, including the negative cases:
  - wrong branch, missing permission;
  - a confirm whose price is incomplete (gives a draft, not an approval), a closed period, a confirm over the
    credit limit;
  - auto-invoice turned off by its switch;
  - a bot request with several items and with an estimate, whose invoice equals the approved total and
    currency;
  - a handover with no invoice, unpaid, a customer with a limit, an override without a reason, an override
    without the permission;
  - races: a confirm against a receipt cancel, and two confirms for one customer;
  - every notice switch off: no outbox row is written.
