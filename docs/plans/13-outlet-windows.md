# 13. Drop-off windows run by partners: from the confirmed booking to the waybill

The owner described the flow on 2026-11-05 (project thread «تشغيل نوافذ الاستلام للشركاء»), in his words:

> لما جا الحجز المبدئي موظف نولون اللي في الفرع المختص حسب المدينة لما يجي ياكد الحجز يكون في دروب داون ليست فيها
> قائمة المنافذ يختار المنفذ وبعدها يوافق علي الحجز … لما يوصل الزبون يوصل ومعاهو عنوان المنفذ ورقم تلفونو ده في المستند وفي
> الرسالة اللي معاهو رابط بالموقع علي قوقل ماب وفي نفس اللحظة … يظهر عند المنفذ عشان يكون عارف ايه الطلبات اللي حيستلمها
> وكمان الفاتورة ويستلم الفلوس ويطلع ايصال للعميل وايرويبل تطلع من السيستم بعد الدفع تترسل عبر البوت للعميل

A **window** (نافذة استلام) is a partner of NOLON (a travel agency, a shop owner) that is also a place where customers
hand over their goods, and that gets a login to do this job. This plan builds the window's side. The build comes in the
PRs of section 8, each after this plan has a Codex OK. Every step is behind a switch, off by default.

## 0. What exists today (main d7b17d7)

| Need                                                | Today                                                                                                                                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The partner and its login                           | A `SALES_OUTLET` partner (partners screen) and users with the `OUTLET_STAFF` role, tied to their outlets (`user_partners`). They see only records sold through their outlet (`salesOutletScope`) and only `@OutletScoped()` routes. |
| The window as a place                               | A warehouse with `accepts_drop_off`, address (ar/en), hours, phone, coordinates or `map_url`, and an optional `partner_id` (an active outlet of the same branch) (09-8).                                                            |
| Staff pick the window when approving a bot request  | Yes: `dropOffId` on approve, from the request branch's drop-off points (`dropOffChoices`), stored in `cs_booking_requests.drop_off_warehouse_id` (09-8).                                                                            |
| The bot tells the customer the window               | Yes: `GET /cs/booking-requests/:id` returns `dropOff {name, address, phone, mapUrl}` once approved (09-8, #201).                                                                                                                    |
| Approval confirms the booking and makes the invoice | Yes, behind `CS_APPROVE_CONFIRMS_ENABLED` (12-4) and the auto invoice (12-2).                                                                                                                                                       |
| The booking confirmation print names the window     | **No.** The window lives only on the bot request.                                                                                                                                                                                   |
| The window sees what it will receive                | **No.** An outlet sees only bookings it sold (`sales_outlet_id`); the window is not on the booking.                                                                                                                                 |
| The window receives the goods (GRN)                 | **No.** Goods receipts need `warehouse:create`, which outlet staff never hold, and warehouse routes are not `@OutletScoped()`.                                                                                                      |
| The window takes the money and gives a receipt      | **No.** Receipts need `receipts:create` and a cash account of the branch.                                                                                                                                                           |
| The waybill (بوليصة) after payment, sent by the bot | **No.** Planned in plan 09 section 7 (N-C4), not built.                                                                                                                                                                             |

## 1. The window travels with the booking (PR 13-1)

- **Additive column** `bookings.drop_off_warehouse_id` uuid NULL, FK `warehouses` (RESTRICT), index.
- Bot approval copies the request's window to the booking in the same transaction. The correction route
  `POST /cs-booking-requests/:id/drop-off` updates both, under the same checks. A staff booking may name a window too
  (optional field on the booking form, same rule: an active drop-off point of the booking's branch).
- **Staff dropdown ⭐ (a):** the choice stays the drop-off point (the place), labelled with its outlet when it has one:
  «نافذة الصفا (تجريبي) · وكالة X». (b) Choosing the partner first and then its place adds a step for one-place partners.
- **Booking confirmation print** (`BookingPrint`) shows a «مكان تسليم البضاعة» block: name, address, hours, phone, a QR
  of the map link and the link itself. Nothing shows when the booking has no window.
- **Agent:** the booking field is new and the agent's views use field allow-lists, so it is ignored. The bot's reply already
  carries the window (09-8). Note for the agent project: the approval message should always print the address, phone and
  map link (ready paste in section 9).

## 2. The window's desk: what it will receive (PR 13-2)

- **Who:** an `OUTLET_STAFF` user whose outlet owns the window (`warehouses.partner_id` ∈ the user's outlets). Nobody else
  gains anything.
- **New outlet-scoped route** `GET /window-desk/expected?status=expected|received|all` returns the CONFIRMED bookings whose
  `drop_off_warehouse_id` is one of the user's windows (`windowScope(user)`, a new fragment next to `salesOutletScope`).
  Per row: booking number, date confirmed, sender name and phone (the window must call the customer), receiver name and
  city, origin and destination, cargo lines (category, quantity, description), the MAIN invoice's number, total, currency
  and balance (no cost, no margin), and what is left to do (receive, collect). Branch scope still applies: the booking's
  branch must be the window's branch.
- **Read only.** It is not a widening of `customerOutletScope`: the window sees the booking's sender and receiver as
  written on the booking, never the customer's file, other bookings or statement.
- **Screen:** «طلبات الاستلام» in the outlet menu: a list (expected first, oldest first), a search by booking number or
  phone, and the booking's print (13-1) and invoice print.
- **It appears at the moment of confirmation** by construction: the list reads confirmed bookings; nothing is copied.
- **Switch:** `WINDOW_DESK_ENABLED` (default false): off, the route is 404 and the menu item is hidden.

## 2a. The window adapter: one scoped entry point for every read, print and write (F202-1)

The window's customers are often **not** its own: a bot customer, or one sold by another outlet, whose goods are assigned
to this window. The ordinary routes do not fit and are **not widened**: `customerOutletScope` and `salesOutletScope` stay
as they are, `/customers`, `/bookings`, invoice and receipt routes keep their scopes, and `receipts:create` and
`warehouse:create` are never given to `OUTLET_STAFF`.

- **One module, `window-desk`, with its own `@OutletScoped()` controller and `WindowDeskService`.** Every route takes a
  booking id and, inside its transaction, first runs `authorizeWindowInTx(tx, user, bookingId)`:
  1. the existing outlet-scope recheck under lock (`outlet-scope.ts`: role, branches and outlets as at sign-in, else 403);
  2. the booking row `FOR SHARE`: CONFIRMED, `drop_off_warehouse_id` not null;
  3. that warehouse `FOR SHARE`: active, `accepts_drop_off`, `partner_id` ∈ the user's outlets, and its branch = the
     booking's branch ∈ the user's branches;
  4. the partner active.

  Anything else is `404` (the window learns nothing about bookings that are not its own). The result is a
  `WindowContext {bookingId, shipmentId, customerId, branchId, warehouseId, partnerId}` that the service passes on.

- **Reads and prints** come only from the adapter, as projections built for the window:
  `GET /window-desk/expected`, `GET /window-desk/bookings/:id` (the row of section 2),
  `GET /window-desk/bookings/:id/print/booking|invoice/:invoiceId|grn/:movementId|receipt/:receiptId`. Each print returns the
  same DTO the existing print screen renders, read by the existing service through an **internal** method that takes the
  `WindowContext` instead of a user scope, and checks that the invoice, movement or receipt belongs to that booking's
  shipment and, for receipts and GRNs, was made at this window. No cost, margin or customer-file field.
- **Writes** call internal service methods that take the `WindowContext` and skip only the two user-scope steps the
  adapter replaced (`customers.requireCustomer` and `workBranch`): `WarehouseMovementsService.receiveForWindowInTx` and
  `ReceiptsService.createForWindowInTx`. Every other check, lock and audit entry of those services runs unchanged, inside
  the same transaction as the adapter. The audit records the user, the window and the partner.
- **Tests (added to section 7):** a customer sold by **another** outlet, assigned to this window: the desk shows it, the
  window receives and collects; the same user on `GET /customers/:id`, `GET /bookings/:id`, `POST /receipts` and
  `POST /shipments/:id/warehouse/receipts` still gets 404/403. A window user whose outlet is removed between sign-in and
  the write: 403. A booking whose window is changed to another partner's after the list was read: 404 on the write.

## 3. The window receives the goods (PR 13-3)

- `POST /window-desk/bookings/:id/receipt` makes a goods receipt (GRN) **into the booking's window**, for the booking's
  shipment, through `WarehouseMovementsService` (same rules, locks, state machine move to `RECEIVED_ORIGIN_WAREHOUSE`,
  audit). The body is the GRN body without `warehouseId`: packages, weight, condition, note, photos.
- **Checks:** the user's outlet owns the window; the booking is CONFIRMED and its window is that warehouse; the warehouse is
  active. No other warehouse, booking or route opens for the outlet. Cancelling a receipt stays with NOLON staff.
- **Permission:** a new key `window_desk:receive`, seeded for `OUTLET_STAFF` only (the role is already locked to
  outlet-scoped routes), and visible on the permissions screen.
- The GRN print is the existing one, with the window's name and the outlet's name on it.
- **As built (13-3):** the permission is `window_desk:create` (the matrix's actions are fixed: create = receive;
  Outlet Staff's level E also brings `window_desk:update`, which no route uses until 13-4 takes the money). A booking
  with a window opens the origin warehouse stage whatever services it names (a bot booking names none; the full-cycle
  trial's BK00044 stayed CREATED), so a window receipt, or a staff GRN, moves the shipment to
  `RECEIVED_ORIGIN_WAREHOUSE` when the state machine allows it; window_desk:create allows that one move only. Lock order
  (F211-1): the shipment's exclusive lock first, as closing and cancelling take it before they write the booking; then
  the window's check (outlets, booking, window `FOR SHARE`). The GRN printout is
  `/print/window-desk/:bookingId/receipts/:movementId`, the same sections as the staff GRN, read from the desk (the
  outlet cannot open the shipment), without the shipment's QR code. Photos on a window receipt are left for later:
  NOLON staff can add them on the shipment.

## 4. The window takes the money and gives the receipt (PR 13-4)

This changes who holds NOLON's cash, so it is an accounting change.

- **Where the money sits ⭐ (a):** each window gets its own cash account per currency, «نقدية لدى نافذة الصفا (SAR)»
  (`is_cash`, the window's branch, under a parent «نقدية لدى الشركاء»). The receipt is the normal receipt
  (`ReceiptsService.create`): Dr that cash account, Cr the customer's receivable, applied to the booking's MAIN invoice.
  The accountant sees at any time how much each window holds. (b) A receivable on the partner instead of a cash account mixes
  the window's cash with its commission statement. (c) Recording nothing until the window pays NOLON leaves the customer
  showing unpaid after paying.
- **Link:** `window_cash_accounts (warehouse_id, currency, account_id)`, unique on `(warehouse_id, currency)`. The
  accountant sets it on the warehouses screen (`accounts:update`). **This names `accounts`, so the migration is not
  additive: it needs the owner's OK and the label** (rule 4).
- **Collection contract (F202-2).** `POST /window-desk/bookings/:id/payment {requestId, amount, currency, reference?}`,
  by `window_desk:collect` (seeded for `OUTLET_STAFF` only).
  - **No allocation input; the server allocates, all of it.** The payable invoices are the live APPROVED invoices of the
    booking's shipment **in `currency`** (MAIN and ADDITIONAL; live = not cancelled, not fully credited), in this order:
    MAIN first, then ADDITIONAL by invoice date, then number; each takes up to its balance. `amount` must be > 0 and
    ≤ the sum of those balances, else `409 WINDOW_OVER_BALANCE {balance, currency}`. So the whole amount is always
    allocated and no advance is ever made by a window. No such invoice: `409 WINDOW_NOTHING_TO_COLLECT`.
  - **Same currency only, no FX.** An invoice in another currency is collected in its own currency; if the window has no
    cash account for it: `409 WINDOW_NO_CASH_ACCOUNT {currency}`.
  - **Idempotency:** `requestId` (uuid, required) becomes the receipt's id, the existing durable mechanism of
    `ReceiptsService.create` (B1-3). A retry by the same user with the same booking, amount, currency and reference returns
    the receipt it posted; any other content under the id is `409 REQUEST_ID_REUSED`. The retry compares the inputs, not
    the computed allocations.
  - **Locks (existing order):** the booking row `FOR SHARE`, then the window's `window_cash_accounts` row and its account
    `FOR SHARE` (active, `is_cash`, currency = `currency`, branch = the window's branch or null), then the invoices as
    `ReceiptsService.createInTx` locks them today; the allocation is computed after those locks, from the balances read
    under them. Two collections racing over the same balance: one 201, the other `409 WINDOW_OVER_BALANCE`.
- The window cannot cancel or apply a receipt; NOLON's finance can, as today.
- The receipt voucher print (existing) is what the window gives the customer, with the window's name on it.
- **Settlement** of the window's cash to NOLON is the existing cash transfer or journal by the accountant; a dedicated
  settlement screen and netting against commission are a later plan.
- **Switch:** `WINDOW_COLLECT_ENABLED` (default false), on top of `WINDOW_DESK_ENABLED`.

## 5. The waybill after payment, sent by the bot (PR 13-5)

- Built as plan 09 section 7 (N-C4): Gotenberg on the internal network, the HTML template in the API, the protected
  download link `GET /cs/documents/:token`, the bot downloads and uploads the file to Telegram. That section's safety rules
  and tests stand.
- **One eligibility predicate, `waybillEligibleInTx(tx, shipmentId)` (F202-3), no exception.** All of:
  1. the shipment and its booking are not cancelled;
  2. the shipment's status is in a fixed list, `RECEIVED_ORIGIN_WAREHOUSE` or later (in the code, not `sort_order`), and
     it has at least one live (not cancelled) goods receipt;
  3. **the handover decision of plan 12 section 3 is OK**, by the same function (`handoverDecision` over the same
     `creditSnapshotSql` read, under the customer's credit lock): so it needs a live APPROVED MAIN invoice, it counts every
     live approved invoice of the shipment including ADDITIONAL, a fully credited or cancelled invoice is not live, and a
     missing FX rate makes it not eligible (`CREDIT_LIMIT_NO_RATE`), exactly as the handover gate. A paid MAIN with an
     unpaid ADDITIONAL and no credit is **not** eligible.
- **Checked every time it matters:** when the link is issued, and again at the download, inside the download's
  transaction. Not eligible at download: `404`, as plan 09 section 7. No copy of the waybill is stored.
- **Readiness and the notice: transactional enqueue, separate worker (F202-4).** No write takes a new lock for this.
  - **Enqueue only.** As the last step of every write that can change the predicate (receipt create, apply, cancel and
    reversal; credit note approve; invoice approve and cancel; goods receipt create and cancel; shipment cancel), the write
    inserts one row per affected shipment into a new table `waybill_checks (shipment_id, enqueued_at)` in its own
    transaction. That is a plain `INSERT` into a table nobody else locks: no shipment row, no credit lock, so a receipt
    covering several shipments and a GRN on one of them never wait on each other here. Duplicates are fine.
  - **Worker** (the same process and polling style as the outbox delivery worker, every 10 seconds): takes a batch with
    `FOR UPDATE SKIP LOCKED`, groups it by shipment, and for each shipment, **in its own transaction**, uses the existing
    handover lock order: the shipment row `FOR UPDATE` first, then the customer's credit lock last (as
    `WarehouseMovementsService` and `requireHandoverInTx` do today). It recomputes `waybillEligibleInTx`, then:
    - eligible and `waybill_ready_at` null: set it and write one `waybill.ready` (the outbox insert is in the same
      transaction, so the notice exists if and only if the episode started);
    - not eligible and `waybill_ready_at` set: clear it, no event (a reversal ends the episode);
    - otherwise nothing.

    It deletes the processed check rows in that transaction. One shipment per transaction means the worker never holds
    two shipments, so it cannot deadlock with a multi-shipment receipt.

  - **Episodes are what the worker observes (F202-5, coalesced on purpose).** An episode starts when the worker finds the
    shipment eligible with `waybill_ready_at` null, and ends when it finds it not eligible with the column set. A reversal
    and a requalification that both commit between two polls are **not** seen as an episode: the worker reads the final
    state (eligible, column set) and does nothing. That is the intended behavior. The customer already holds a waybill
    notice, the waybill is never stored (each download renders the current shipment), and the download rechecks the
    predicate, so there is nothing new to tell them. Each episode the worker observes writes exactly one event. Two workers
    on the same shipment serialize on its row lock, and the second sees the column already set.
  - **Latency:** the notice follows the payment within about 10 seconds. The download never depends on the column: it runs
    the predicate itself (above).
  - **Tests:** a receipt over two shipments racing a GRN on one of them (both commit, no deadlock, one event); receipt
    cancelled while a check is queued (no event, column cleared); a cancellation and a repayment both committed before the worker runs (no second event, column stays set, download still works); two workers on one batch (one event); requalification
    after reversal (a second event); a check row for a shipment that is not eligible (no event).
- **Switch:** `CS_NOTIFY_WAYBILL_ENABLED` (default false). Off: the column still tracks readiness, no event is written,
  and the download route is 404. The customer can also ask the bot for the waybill; the same predicate decides.
- **Agent first:** the event type and the download need the erp-agents compat PR merged and deployed before the switch is
  turned on (compat rule).

## 6. Decisions taken for the owner (⭐, into the decisions file)

1. The staff dropdown lists drop-off points labelled with their outlet (section 1 (a)).
2. The window sees sender and receiver names and phones of its expected bookings only, never customer files (section 2).
3. The window receives into its own place only and cannot cancel (section 3).
4. Each window holds NOLON's cash in its own cash account per currency (section 4 (a)); settlement by the accountant.
5. The waybill is ready when the goods are received at origin and the invoice is paid or within credit (section 5).
6. Every step is behind a switch, off by default.

## 7. Tests (rule 7)

- 13-1: the request's window reaches the booking; correction updates both; a window of another branch or not accepting
  drop-off: 400; the print block shows only with a window.
- 13-2: a window user sees only bookings at their windows: another outlet's window, a sales-outlet booking at another window,
  a draft or cancelled booking, another branch: absent; a non-outlet user: 403; switch off: 404; no cost fields.
- 13-3: receipt at own window: 201, status moves; another window, another booking, a draft booking: 404/409; no
  `window_desk:receive`: 403; the outlet cannot reach `POST /shipments/:id/warehouse/receipts`.
- 13-4: receipt into the window's account, fully allocated MAIN first then ADDITIONAL, posted balanced; over the balance:
  409; another currency without an account: 409; an inactive or other-branch mapped account: 409; another window's booking:
  404; same `requestId` same content: the same receipt; changed content: 409; two simultaneous collections over one balance:
  one 201 and one 409; switch off: 404; cancel by the window: 403; journal immutability unchanged.
- 13-5: plan 09 section 7 tests, plus: MAIN paid and ADDITIONAL unpaid: not eligible; no approved MAIN: not eligible;
  MAIN fully credited: not eligible; missing FX with a positive limit: not eligible; paid at the window: one
  `waybill.ready`; receipt cancelled after that and the worker runs: `waybill_ready_at` cleared, download 404, no event; paid again and
  the worker runs: a second `waybill.ready`; cancelled and repaid before the worker runs: no second event; GRN cancelled: not eligible; switch off: no event and download 404.

## 8. PRs (each one push when complete, Codex review, all checks green)

| PR   | Content                                                    | Migration                                     |
| ---- | ---------------------------------------------------------- | --------------------------------------------- |
| 13-1 | Window on the booking, dropdown label, confirmation print  | additive                                      |
| 13-2 | Window desk: expected list (switch)                        | none                                          |
| 13-3 | Window receives the goods (switch)                         | additive (permission seed only if needed)     |
| 13-4 | Window takes the money (switch)                            | **owner OK + label** (`window_cash_accounts`) |
| 13-5 | Waybill PDF + `waybill.ready` (switch, agent compat first) | additive (`cs_document_links`)                |

## 9. Agent project (ready paste, after 13-1 and before 13-5)

- The approval reply should always print the window's name, address, phone and map link from `dropOff` (already in the
  read since 09-8).
- 13-5: accept the `waybill.ready` event; on it (and on the customer's request) download the waybill with the key and the
  owner proof, and send it to the customer as a Telegram document. Merge and deploy before `CS_NOTIFY_WAYBILL_ENABLED`.
