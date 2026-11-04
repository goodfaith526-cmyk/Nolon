# 11. Marketing summary (read only)

Asked by the marketing agent project (erp-agents) on 2026-11-04: live prices and real booking
numbers for its plan, instead of assumptions. One read, aggregates only, no customer data.

## Access

- `GET /api/v1/marketing/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`, with a Customer Service API key
  (`Authorization: Bearer nolcs_...`).
- New scope `cs:marketing:read` (row `MARKETING_READ`): the summary. The Administrator gives it on
  the API keys screen, best on a key of its own for the marketing agent (no other scope).
- New scope `cs:marketing:revenue:read` (row `MARKETING_REVENUE_READ`): the explicit financial
  permission. Without it the `revenue` field is absent (not empty, not zero).
- No write route. 401 without a valid key, 403 `SCOPE_REQUIRED` without `cs:marketing:read`.
- Period: both days included, `to` not before `from` (400 `BAD_RANGE`), at most 12 calendar months
  from `from`'s month to `to`'s (400 `RANGE_TOO_LONG`). Unknown query fields are refused (400).

## What it returns (`MarketingSummaryDto` in `@nolon/shared`)

| Field          | Content                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `places`       | Id, code, kind, Arabic and English names, country of every place the summary names.                                         |
| `categories`   | Code, names and unit of every shipment type it names.                                                                       |
| `routes`       | Each origin, destination and mode with an approved freight price today, its load and shipment types.                        |
| `prices`       | Each approved freight card valid today (UTC) for a shipment type: price, minimum, currency, unit, validity, transit days.   |
| `monthly`      | Per month, route and shipment type: requests (`bot`, `website`, `branch`, `total`) and bookings (`confirmed`, `cancelled`). |
| `newCustomers` | Every month of the period (zeros included): people whose first customer account was opened.                                 |
| `revenue`      | Only with the revenue scope: per month, route and currency, `invoiced`, `credited`, `net` as decimal strings.               |

## Rules behind the numbers

- **Prices** are the freight cards of every branch a bot quote can use today, one per offer, as
  `RatesService.systemScopedRates` reads them: APPROVED and valid today; of cards that differ only
  by their start date, the latest started (Codex F186-1); and a shipment type, currency and both
  places still active, as the quote's checks (F186-2). Each card is the price of its own route
  scope (a place, a city or a country: `places[].kind`); for one place the quote prefers the
  narrowest scope. Selling price only: no cost, margin, branch or staff name.
- **Branches**: requests, bookings and revenue are the key's branches' only (rule 2). A request
  still awaiting routing counts for a key that serves one of its candidate branches.
- **Requests**: bot requests made in the period (the day in the request's branch, UTC while awaiting
  routing), any status. `website` is the website chat (sender channel `web`); `bot` is Telegram,
  WhatsApp or a customer-token request. `branch` is a booking staff entered without a bot request.
- **Bookings**: made in the period (the day in their branch), by their status now: `confirmed` is
  CONFIRMED or COMPLETED, `cancelled` is CANCELLED. A booking made from a bot request is a booking,
  not a second request.
- A request or booking with several shipment types counts once under each; a route or type not
  known yet is `null`.
- **Revenue**: approved invoices with a posted entry (no opening items) by invoice date, less
  approved credit notes against them by credit date, by the shipment's route, in the invoice
  currency (never converted). Not split by shipment type: invoice lines are by charge, not type.
- **New customers** count every branch (customers are central, owner 2026-11-04). A person is the
  unified profile, or the account when it has none: a second branch account is not a new customer.
- Nothing in the answer names a customer: no name, number, phone, sender, invoice or booking number.

## Not in this step

- Small-count suppression (a month with one booking on a rare route is still a number, not a record).
- Conversion of revenue to one currency.
