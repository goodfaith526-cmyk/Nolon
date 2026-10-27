# Plan: shared-container space left, route-coded LCL numbers, shipment keeps the booking number

Date: 2026-10-27. Source: client WhatsApp (Musab, Shaker), 27 Oct 2026. Plan only; nothing is built
until Codex reviews this plan.

**Owner decisions (2026-10-27 23:26, answers to س1-س6 of the first draft):**

- س1 = أ: we seed usable capacities for 20GP/40GP/40HC; the admin can edit them. This is the owner's
  OK to update the existing `container_types` rows.
- س2: the fill level must be visible **before** the container is full; going over capacity is
  **blocked**, with a warning.
- س3 = both: the shared container **and** LCL bookings get route-coded numbers.
- س4: **old numbers change.** The system is not in live operation yet; existing records are
  renumbered to the new scheme (section 4).
- س5 = continuous counter, never resets.
- س6 = we seed the city letters (owner's OK to update the existing `locations` rows).

Base: `main` 4300b72. Open PRs touching nearby code: #109 (status history, container close rules),
#104 (status locks), #108 (outlet staff). None changes numbering or capacity; whichever merges second
rebases.

## 1. Shared container: space left while it fills (Musab)

Today: `container_types` (20GP, 40GP, 40HC, OTHER) has no capacity. The container page lists its
shipments with their weight and CBM (`consolidations.service.ts`, `volumeCbm`/`weightKg` summed from
shipment items) but shows no total against a limit.

Change:

- `container_types` gets two nullable columns: `max_volume_cbm Decimal(18,4)` and
  `max_payload_kg Decimal(18,4)`: usable capacity, not the nominal inside volume. Editable in the
  existing master-data screen (Admin only, as today). Seed (owner س1): 20GP 28 CBM / 28,000 kg;
  40GP 58 CBM / 26,500 kg; 40HC 68 CBM / 26,500 kg; `OTHER` stays empty.
- `GET /consolidations/:id` returns a `capacity` block computed in the service, all Decimal strings:
  `maxVolumeCbm`, `maxPayloadKg` (null when the type has none), `usedVolumeCbm`, `usedWeightKg`,
  `remainingVolumeCbm`, `remainingWeightKg`, `fillPercent` for each, and `incomplete`: the shipment
  numbers with no CBM or no weight on a cargo line. Missing values are never silently zero: the total
  is labelled incomplete and the shipments are listed («غير مكتملة»).
- Seen before it is full (owner س2):
  - Container page (`ConsolidationDetail.tsx`): a panel at the top, two bars (CBM, weight) with used
    / capacity / left; amber from 80 %, red at 100 %.
  - Containers list: a "filled" column (the higher of the two percentages) with the same colours,
    so staff see which open containers still have room without opening each.
  - Adding a shipment: the picker shows each candidate's CBM and weight and "left after adding";
    candidates that would not fit are shown disabled with the reason.
  - When the type has no capacity: "set the capacity of this container type" (link for admins), and
    no limit applies.
- **Block** (owner س2): a write that would put an OPEN container over its capacity on CBM **or**
  weight is refused with 409 `CONTAINER_FULL` naming the used, capacity and attempted numbers. The
  check runs in the service, inside the write's transaction, after the container row lock that
  `addShipments` already takes, so two staff adding at once cannot both slip past the limit. It
  covers adding shipments (create with shipments, add, move into a container) and editing cargo
  lines of a shipment that sits in an open container, wherever such an edit exists.
- A shipment with missing CBM or weight can still be added (it shows in `incomplete`, the bar says
  "incomplete", and closing the container already requires the basis value). Blocking it would stop
  work on data that is simply not entered yet; the check uses the known values.
- If an admin lowers a type's capacity below a container's current load, nothing is undone: the
  panel shows red and further additions are blocked.
- Closed containers show the panel read-only from the frozen basis.

Tests: unit for the capacity maths (Decimal, rounding at display only, missing lines, exactly at
capacity is allowed, one unit over is refused); integration: other branch gets 404 (existing rule),
capacity null for `OTHER`, over-capacity add refused on CBM and on weight, concurrent adds (only one
of two that each fit alone but not together succeeds), move into a full container refused, incomplete
list.

## 2. Route-coded LCL numbers (Musab)

Format: `<ORIG>-<DEST>-<NNNN>`, four digits zero-padded, a fifth digit after 9999. No year, never
resets (owner س5). Applies to (owner س3):

- **LCL bookings** (`load_type = LCL`): `DXB-KRT-0001`. Their shipment carries the same number
  (section 3).
- **Shared containers**: `DXB-KRT-C0001` (the `C` keeps a container and a booking of the same route
  from carrying the same text; our choice, the owner may change the letter).
- FCL bookings and road bookings without a load type keep `BK00001`; their shipments take that
  number.

Counters: the existing `number_sequences` table, inside the creating transaction (row lock serialises
concurrent creators, rollback returns the number): `doc_type = 'LCL_BOOKING'` or `'LCL_CONTAINER'`,
`period_key = 'DXB-KRT'` (fits `VARCHAR(10)` with letters capped at 4). Uniqueness: each table's
`number` is already `UNIQUE`; DXB-KRT and KRT-DXB are separate counters.

Letters: location codes are UN/LOCODEs (AEJEA Jebel Ali, AEDXB Dubai, SAJED, SDPZU Port Sudan,
SDATB, SDKRT), and PZU is not the client's PTS. So `locations` gets a nullable
`short_code VARCHAR(4)` (2-4 upper-case letters, check constraint), editable in master data. Letters
used: the location's `short_code`, else its city's, else the last three letters of its LOCODE.
Seed (owner س6): AEJEA, AEDXB -> DXB; SAJED -> JED; SDPZU -> PTS; SDATB -> ATB; SDKRT -> KRT.

A draft booking's route or load type can still change. While the booking is a DRAFT (no shipment
yet), a change of origin, destination or LCL/FCL gives it a new number from the right counter (the
old number is left unused and the change is in the audit log). Once confirmed the number never
changes. A container's route is fixed at creation.

Tests: format, per-route counters, the two kinds don't share numbers, concurrent create, fallback
letters, short code validation, draft route change re-issues, confirmed booking keeps its number.

## 3. Shipment keeps the booking number (Shaker)

Today: confirming a booking creates the shipment with a new `NOL-SHP-<year>-<6 digits>`
(`ShipmentsService.createForBooking`, sequence `SHIPMENT`).

Change: the shipment's `number` is the booking's `number`. One shipment per booking
(`shipments.booking_id` is unique), so it stays unique among shipments. The `SHIPMENT` sequence is no
longer used. `shipments.number` is `VARCHAR(30)`; no schema change.

## 4. Renumbering existing records (owner س4)

One data migration, raw SQL, in one transaction, in this order:

1. Seed `short_code` and capacities (sections 1, 2).
2. LCL bookings: new number per route, in `created_at, id` order.
3. Containers: new number per route, in `created_at, id` order.
4. Shipments: `number = booking.number` for every shipment.
5. `number_sequences`: set `LCL_BOOKING`/`LCL_CONTAINER` per route to max + 1. `BOOKING` and
   `SHIPMENT` rows stay (FCL keeps BK; the BK numbers LCL bookings vacate are simply gaps).

Uniqueness during the update: new formats never collide with old ones (`NOL-CON-...`,
`NOL-SHP-...`, `BK...` vs `DXB-KRT-...`), and a shipment takes a number no other shipment has, so a
single `UPDATE ... FROM` per table keeps the unique indexes valid.

What is untouched, and why it is safe:

- Records point to each other by id, never by number (bookings, shipments, containers, invoices,
  drafts, documents). Display names are read live (`drafts/reference-names.ts`).
- Public tracking links and QR codes carry a random token (`tracking_token`), not the number: every
  link and printed QR keeps working.
- Posted journals never carried shipment or container numbers (they use invoice and receipt numbers),
  so the immutability triggers are not involved.
- Append-only history keeps the old text where it was written: `audit_events`,
  `agent_access_events`, and `shipment_events.note` (holds the container number on container status
  moves). Not rewritten: the audit trigger forbids it and history should show what was true then.
  The shipment page will show those old container numbers in old notes; acceptable on test data.
- Already printed or exported PDFs (acceptance files) show old numbers; they are test papers.

Migration rule 4: this migration updates existing rows, so it is not additive. The owner gave the
OK in their own words (2026-10-27 23:26, «القديمة دي تتغير»). Before the `migration-ok-<digest>`
label: Codex reviews it; the staging deploy takes and verifies its own backup before migrations.
Production has no data yet.

## 5. Other effects checked

- NOLON search, invoices, statements, prints, reports: show `number` as a string, no format
  assumption. Searching `DXB-KRT-0001` or `BK00012` finds the booking and its shipment.
- Public tracking by reference + last 4 phone digits: reference length 5-30, new forms pass. A route
  number is easier to guess than the yearly one, but the lookup still needs the phone's last 4 digits
  and stays rate-limited per reference and per IP. Placeholder in `PublicTracking.tsx` changes.
- Customer Service API (`/customer-service/shipments/:number`): accepts any 1-30 character
  reference; unchanged.
- **Agent (erp-agents), breaking**: `connectors/nolon/nolon-customer.ts` validates shipment numbers
  with `/^NOL-SHP-\d{4}-\d{6}$/` on the tool input _and_ on NOLON's response, and finds references in
  customer messages with an `SHP-` pattern; `nolon-status.ts` matches `shp-YYYY-...` in staff
  messages. After this change no shipment has that form, so the customer WhatsApp tool would refuse
  every shipment. Per the compat rule an erp-agents compat PR merges **first**: accept `BK\d{5,}`,
  `[A-Z]{2,4}-[A-Z]{2,4}-\d{4,}` and the old `NOL-SHP-...`, in input, response and message matching,
  with tests. Old numbers in past agent conversations will no longer be found; acceptable, the system
  is not live. Agent draft routes are unchanged (no new field in any draft route); the capacity block
  and `short_code` are response additions the agent's non-strict response parsing ignores.

## 6. Order of PRs

1. erp-agents compat PR (number patterns). Merges first.
2. NOLON PR-A: migration (columns, seeds, renumbering) + route-coded numbers + shipment takes the
   booking number. One PR, because the renumbering and the new numbering rules must land together.
3. NOLON PR-B: capacity panel, list column, picker, and the over-capacity block.

## 7. Codex review at b60a54d: answers (F111-1 to F111-4 and conditions 1-7)

This section wins where it differs from the sections above.

**F111-1, who sees what in the capacity block.** `findViewable` lets three kinds of user see a
container: its own branch (`own`), another branch that may book into an OPEN container, and another
branch with a shipment in it. `toDto` already shows the last two only their own shipments. The
capacity block follows the same split:

- Own branch: the whole block, including the numbers of incomplete shipments.
- Any other viewer: only container-level aggregates (capacity, used, left, fill %, and per dimension
  whether the total is complete), plus incomplete flags on **their own** shipments only. No other
  branch's shipment number, customer or per-shipment measure appears. The aggregate is computed over
  **all** shipments in the container, never the visible subset, because space left is what a booking
  branch needs to decide to book into a shared container; it reveals a combined volume and weight,
  not whose cargo it is. If the owner wants other branches to see only "has room / full", that is a
  one-line switch in the same service.
- Tests: a mixed-branch container seen by its branch, by a booker of another branch without
  shipments in it, by another branch with one linked shipment (sees only its own incomplete flag),
  and an outsider (404, as today).

**F111-2, deployed agent first, and rollback.** Merging the erp-agents compat PR is not enough:

1. erp-agents compat PR merged **and deployed** to the agent preview; the owner confirms the running
   sha (the version the agent's health page shows) is at or after the compat commit.
2. Smoke test on that deployment against NOLON staging, with old, new and mixed references: customer
   shipment list and detail, an invoice whose `shipmentNumber` is new, and a staff message naming a
   new number.
3. Only then NOLON PR-A merges (its staging deploy runs the renumbering).

PR-A's description carries this gate as a checklist, and it is not merged until the owner ticks it.
No runtime flag: the renumbering migration rewrites existing rows, so a flag could not hold old
numbers back anyway. Rollback: the renumbering is forward-only. After it, NOLON code may roll back
(old code only stores and shows `number` as text), but the agent must never go back below the
compat commit. The compat change keeps accepting the old `NOL-SHP-...` form for good. Tenant,
customer and branch checks are not touched.

**F111-3, closed containers.** No snapshot. A closed container's panel uses its current cargo lines
and the container type's current limits and says so ("as of now, not at closing"). `basisValue` and
cost shares stay exactly as they are. Tests: CBM-basis and weight-basis closed containers, an old
closed container without measures, and a capacity edit after closing (the panel changes, cost shares
do not).

**F111-4, letters fail closed.** Letters resolve as: the location's `short_code`, else its city's
`short_code`, else the last three characters of its code **only if** they are three letters. The
result must match `^[A-Z]{2,4}$`; otherwise creating an LCL booking or a container on that route is
refused with 422 `ROUTE_CODE_MISSING` naming the location, so the admin sets its short code first.
No alias is invented. Tests: internal code (`AE12A`), numeric tail, one-character code, city
fallback, explicit short code.

The renumbering migration applies the same rule in SQL. A record whose route does not resolve keeps
its old number (logged with `RAISE NOTICE`, listed in the deploy log), so a stray location cannot
fail the deploy. The six seeded locations all resolve.

**Conditions:**

1. Completeness is per dimension and per cargo line: a shipment with any line missing CBM is
   incomplete for CBM. The panel shows known totals separately; a dimension with unknown cargo is
   never green: it shows "at least X used, incomplete" in grey. The block uses known values: if the
   known load alone goes over, it is refused. Limits must be positive; null means "no limit set".
2. The add/move check and the picker estimate use the same service function, run against the
   container's membership read after the row lock, for create-with-shipments, add, move between
   containers and booking into a container. The estimate names the uncertain dimension. Display
   rounding only; allocation and frozen shares untouched.
3. Capacity: positive Decimal(18,4) (> 0, at most 4 decimal places); short code: 2-4 letters.
   Admin-only (existing master-data permission), audited like other master-data edits, with
   permission tests. Records on a deactivated type or location stay readable.
4. A CANCELLED booking cannot be confirmed (existing rule); the test asserts the refusal, no second
   shipment and no new number.
5. Counters: two namespaces, `LCL_BOOKING` and `LCL_CONTAINER`, each keyed by the **rendered** route
   letters (so Jebel Ali and Dubai, both `DXB`, share one counter). The container's `C` keeps the two
   kinds' texts apart. Within each namespace numbers are serialised and gapless except that a draft
   booking re-issued after a route or LCL/FCL change leaves its old number unused.
6. Formats are final (owner: both kinds, continuous): bookings and shipments `BK\d{5,}` or
   `[A-Z]{2,4}-[A-Z]{2,4}-\d{4,}`; containers `[A-Z]{2,4}-[A-Z]{2,4}-C\d{4,}` (containers are not
   shipment references, so the agent's shipment patterns do not include them). Longest realistic
   number is well under 30 characters; public lookup minimum 5 holds.
7. Owner choices are made (decisions at the top). The seeded capacities are defaults, not verified
   limits: the master-data screen labels them "default, set your real limits".

**Agent compat PR tests:** old, new and mixed lists; invoice responses with a new `shipmentNumber`;
Arabic-digit input; customer text boundaries; staff selections (`shipmentSelections`,
`namedShipment`) with new numbers; ambiguous numeric suffixes (`0001` on two routes asks, never
picks); `9999` to `10000`; no selection outside the authenticated customer, branch and tenant. No
catch-all reference pattern.
