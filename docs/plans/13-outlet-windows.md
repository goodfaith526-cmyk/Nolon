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

## 3. The window receives the goods (PR 13-3)

- `POST /window-desk/bookings/:id/receipt` makes a goods receipt (GRN) **into the booking's window**, for the booking's
  shipment, through `WarehouseMovementsService` (same rules, locks, state machine move to `RECEIVED_ORIGIN_WAREHOUSE`,
  audit). The body is the GRN body without `warehouseId`: packages, weight, condition, note, photos.
- **Checks:** the user's outlet owns the window; the booking is CONFIRMED and its window is that warehouse; the warehouse is
  active. No other warehouse, booking or route opens for the outlet. Cancelling a receipt stays with NOLON staff.
- **Permission:** a new key `window_desk:receive`, seeded for `OUTLET_STAFF` only (the role is already locked to
  outlet-scoped routes), and visible on the permissions screen.
- The GRN print is the existing one, with the window's name and the outlet's name on it.

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
- `POST /window-desk/bookings/:id/payment {amount, currency, method: CASH, reference?, requestKey}`: only to the booking's
  MAIN or ADDITIONAL invoices, only up to their balance, only into the window's own account for that currency, only by
  `window_desk:collect` (seeded for `OUTLET_STAFF`). The window cannot cancel a receipt; NOLON's finance can, as today.
- The receipt voucher print (existing) is what the window gives the customer, with the window's name on it.
- **Settlement** of the window's cash to NOLON is the existing cash transfer or journal by the accountant; a dedicated
  settlement screen and netting against commission are a later plan.
- **Switch:** `WINDOW_COLLECT_ENABLED` (default false), on top of `WINDOW_DESK_ENABLED`.

## 5. The waybill after payment, sent by the bot (PR 13-5)

- Built as plan 09 section 7 (N-C4): Gotenberg on the internal network, the HTML template in the API, the protected
  download link `GET /cs/documents/:token`, the bot downloads and uploads the file to Telegram. That section's safety rules
  and tests stand.
- **When it is ready ⭐:** the shipment is `RECEIVED_ORIGIN_WAREHOUSE` or later (plan 09) **and** the MAIN invoice is
  approved with nothing left to pay, or the customer is within a positive credit limit (the same current check as the
  handover gate, plan 12 section 3). The window's payment (13-4) therefore makes it ready at once.
- **Notice:** a new outbox event `waybill.ready` in the transaction that makes it ready (the receipt's or the GRN's), behind
  `CS_NOTIFY_WAYBILL_ENABLED` (default false). The bot then downloads the waybill and sends it. The customer can also ask
  for it.
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
- 13-4: receipt into the window's account, applied, posted balanced; over the balance: 409; another currency without an
  account: 409; another window's booking: 404; switch off: 404; cancel by the window: 403; journal immutability unchanged.
- 13-5: plan 09 section 7 tests, plus: unpaid: not ready; paid at the window: ready and one `waybill.ready`; switch off: no
  event.

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
