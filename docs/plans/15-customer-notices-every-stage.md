# Plan 15: a notice to the customer at every stage, and pallets that move what they carry

Owner, 2026-11-08: «عايزين شفافية كاملة الزبون يجيهو اشعار في كل مرحلة شنو هي المراحل وكيف يتم الادخال ؟ بعدين
الطبلية الفيها كمية طرود او حاوية فيها كمية شحنات الابديت بتاعا تلقائيا بعمل ابديت للشحن الجواها».

Two asks: (1) the stages the customer is told about and how each is entered, (2) a pallet or a container moves every
shipment inside it with one update. The choices marked ⭐ are made here and recorded for the owner; any of them can be
changed later with a small PR.

## 1. What exists today (main 3351a29)

- **Internal statuses** (21, `ShipmentStatus`, `shipments/state-machine.ts`): every change goes through
  `ShipmentsService.advanceInTx` and writes a `shipment_events` row.
- **Customer stages** are master data: `customer_stages` (9 rows) and `shipment_status_stages` (status → stage). The
  Administrator can rename, reorder, add stages and remap statuses on the customer stages screen.
- **Notices exist end to end but are off.** Every status change calls `ShipmentStatusListenersRegistry`;
  `CsEventsService` writes `shipment.stage_changed` (only when the customer's stage really changes) and
  `shipment.delivered` to the outbox `cs_outbox`, in the same transaction. `CsOutboxWorker` sends them signed to the
  bot (erp-agents `erp-events.ts`), which reads the request again and tells the customer. On staging and production
  `CS_WEBHOOK_SECRET` is unset and `CS_WEBHOOK_WORKER_ENABLED=false`, and no endpoint is approved: nothing is sent.
- Notices exist only for shipments made from a **bot booking request** (the stream is per request).
- **A container already moves its shipments.** A consolidation's steps (close, load, depart, arrive, unpack) move every
  shipment in it through the state machine, all or nothing, naming the shipments that cannot move
  (`ConsolidationsService.moveShipments`). A **trip** does the same for its shipments (scheduled, departed, arrived).
- **There is no pallet.** `PALLET` is only a cargo type and a price unit.

## 2. The stages the customer is told about

Today several real steps fall into one customer stage, so the customer hears nothing when the goods are loaded, when
customs start, or when the driver leaves with them. ⭐ Three stages are added (12 in all):

| #   | Customer stage (code)      | Arabic text the bot is given     | Internal statuses                            | How it is entered (who, where)                                                                 |
| --- | -------------------------- | -------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | BOOKED                     | حجز مبدئي                        | (request not decided, booking still a draft) | Automatic: the customer books with the bot or on the website                                   |
| 2   | CONFIRMED                  | مؤكد لدى منفذ الشحن              | CREATED, PICKUP_SCHEDULED                    | Automatic: staff approve the request (booking confirmed, shipment made)                        |
| 3   | AT_ORIGIN_HUB              | استلمنا بضاعتك في مركز التجميع   | RECEIVED_ORIGIN_WAREHOUSE, CONSOLIDATED      | Window staff: «استلام» on the window screen (GRN), or warehouse staff GRN                      |
| 4   | **LOADED** (new)           | تم تحميل الشحنة                  | LOADED                                       | Automatic from the container's «تحميل» (or the pallet's), or by hand on the shipment page      |
| 5   | AT_SEA                     | في الطريق البحري                 | DEPARTED, IN_TRANSIT                         | Automatic from the container's «إبحار»                                                         |
| 6   | AT_PORT                    | وصلت الميناء                     | ARRIVED_PORT                                 | Automatic from the container's «وصول»                                                          |
| 7   | **IN_CUSTOMS** (new)       | في التخليص الجمركي               | CUSTOMS_IN_PROGRESS                          | Customs staff: open the customs file (customs tab)                                             |
| 8   | AT_CENTRAL_HUB             | في مركز التوزيع المركزي          | CUSTOMS_CLEARED, TRIP_SCHEDULED              | Customs staff: «تم التخليص»; transport staff: add to a trip                                    |
| 9   | ON_ROAD                    | في الطريق البري إلى المدينة      | ROAD_DEPARTED, ROAD_IN_TRANSIT               | Automatic from the trip's «انطلاق»                                                             |
| 10  | AT_DESTINATION_HUB         | في مركز التوزيع في مدينة المستلم | ROAD_ARRIVED, RECEIVED_DESTINATION_WAREHOUSE | Automatic from the trip's «وصول», or destination warehouse GRN                                 |
| 11  | **OUT_FOR_DELIVERY** (new) | خرجت للتوصيل                     | OUT_FOR_DELIVERY                             | Delivery staff: «خرجت للتوصيل» on the shipment page                                            |
| 12  | DELIVERED                  | تم التسليم                       | DELIVERED, CLOSED                            | Driver/window: proof of delivery (POD, signature) on the phone; or goods release at the window |

- ON_HOLD, PARTIALLY_DELIVERED and CANCELLED keep sending the customer to staff (no stage), as today. ⭐ A notice for
  "on hold" is a later step (15-4): the bot is told to say a staff member will call, never the internal reason.
- 15-2 also gives AT_ORIGIN_HUB and AT_PORT the names above (F229-3). Stage names are editable by the Administrator,
  so the migration renames a row only while it still carries its seed name; an edited name is left as it is.
- The bot is given the stage name, the city and the shipment number as facts; **it writes the words itself**. The
  stage names above are what the customer sees in a read and on the tracking page, not a fixed message.
- ⭐ A stage is announced once: two statuses that map to the same stage make one notice (as today).
- ⭐ Picking up from the customer's door stays inside CONFIRMED (no "picked up" stage) until pickups are offered.

## 3. A container or a pallet moves what it carries

### Container (exists)

Nothing to build. Loading, sailing, arriving and unpacking a container already move every shipment in it, each through
the state machine, in one transaction; each move is a status change, so each shipment gets its own notice once
notices are on. A trip does the same for road legs.

### Pallet (new, 15-3) ⭐

A pallet (طبلية) is a group of shipments wrapped together in a warehouse, to be handled as one piece.

- ⭐ A pallet holds **whole shipments** (all the parcels of a shipment go on the same pallet), and a shipment is on
  one live pallet at a time. A shipment too big for one pallet is not palletised (it moves by itself, or in the
  container). Splitting one shipment over two pallets is not supported: its status would have no single answer.
- Number: the warehouse's branch code, `P` and a serial, e.g. `JED-P0001`. It belongs to the warehouse's branch
  (branch-scoped like containers; a shipment of another branch is added only by its own branch, as in containers).
- Pallet states: `OPEN` (shipments added and removed, by typing the number or scanning the shipment sheet's QR),
  `CLOSED` (wrapped: contents fixed), `UNPACKED` (opened, each shipment goes on by itself), `CANCELLED` (only while it
  was never moved and never carried). There is no reopening: a pallet built wrong is unpacked and a new one made.
- **One live pallet per shipment** (F229-4): `pallet_shipments.active` is true while the pallet is OPEN or CLOSED, with
  a partial unique index on `(shipment_id) WHERE active`; unpacking or cancelling the pallet sets it false (the rows
  stay as history), removing a shipment from an OPEN pallet deletes its row. The service also checks it under the
  shipment's lock, as containers do.

**Carriers: one mover at a time** (F229-1). A pallet is _carried_ while it is in a container that is not unpacked or
cancelled (OPEN, CLOSED, LOADED, DEPARTED, ARRIVED), or on a trip that is PLANNED or DEPARTED. The pallet keeps its
carrier (`consolidation_id`, `trip_id`, nullable).

- **Put a pallet in a container or on a trip**: CLOSED pallets only, and only while not carried. One action adds all
  its shipments to the container (OPEN) or the trip (PLANNED) in one transaction, with the container's capacity and
  branch rules or the trip's branch rules, and records the carrier. From then on the container or trip moves them;
  the pallet's own move is **refused** while it is carried (409 `PALLET_CARRIED`).
- **Take a pallet out**: only the whole pallet, while the container is OPEN or the trip PLANNED, in one action. Taking
  one shipment of a CLOSED pallet out of the container or off the trip is refused (409 `SHIPMENT_ON_PALLET`, naming
  the pallet): a hook in `ShipmentLinksRegistry` that the container's and the trip's remove and move-to-another-container
  call. No part of a pallet leaves a container.
- **When the carrier is done**: the container unpacked (DECONSOLIDATED) or the trip ARRIVED or COMPLETED (or either
  cancelled) ends the carrying; the pallet stays CLOSED, free to go in the next container or trip, to move by itself,
  or to be unpacked.
- **A shipment on a CLOSED pallet**: it cannot be removed from the pallet (unpack the pallet instead) and cannot be
  cancelled (the cancel blocker of `ShipmentLinksRegistry` names the pallet, as containers under way do); a step the
  pallet recorded cannot be undone from the shipment page (the revert blocker, by the pallet number in the event's
  note). A forward move by hand stays possible, as in containers: the next pallet move leaves a shipment already at
  that step or beyond it on the same leg as it is, and moves the others.
- **Unpack**: only while not carried. Each shipment then goes on by itself.

**Move a pallet** (F229-2), when it travels without a NOLON container or trip (e.g. loose cargo handed to a carrier):
only **transit steps**: LOADED, DEPARTED, IN_TRANSIT, ARRIVED_PORT. Every shipment on it moves to that status through
the state machine, **all or nothing**: if one cannot take the step, nothing moves and the screen names it. Each
shipment's event carries the pallet number in its note. Receiving goods (RECEIVED_ORIGIN_WAREHOUSE,
RECEIVED_DESTINATION_WAREHOUSE) is never a pallet move: it stays the warehouse receipt (GRN) per shipment, which
writes the stock movement. ⭐ A "receive the whole pallet" that runs one GRN per shipment, all or nothing, is a later
step if the warehouse asks for it.

- The pallet label prints with a QR that opens the pallet's page on a phone (no camera library: the phone's camera app
  opens the link).
- Permissions, branch-scoped to the pallet's branch: `warehouse:view` to see pallets; `warehouse:create` to make one;
  `warehouse:update` to fill, close, move and unpack; `warehouse:cancel` to cancel. Putting a pallet in or out of a
  container also needs `consolidation:update`; on or off a trip, `transport_trips:update`. Each shipment move still
  needs the stage's own permission (`ShipmentsService.advanceInTx`). Behind the switch `PALLETS_ENABLED` (off by
  default: every pallet route is 404 and the menu item is hidden).
- Database: new tables `pallets` and `pallet_shipments` (additive). Each pallet keeps who and when for every step
  (created, closed, carried, unpacked, cancelled with its reason); the shipments' own events record every move.

## 4. Turning notices on

Nothing is told to any customer until notices are switched on, on both servers (owner rule: staging and production
together):

1. NOLON: `CS_WEBHOOK_SECRET` (a new random secret), `CS_WEBHOOK_ALLOWED_HOSTS` (the bot's host),
   `CS_WEBHOOK_WORKER_ENABLED=true` in `switches.env`, then `./deploy.sh`.
2. NOLON admin screen: add the bot's endpoint for the booking bot's key and approve it.
3. Bot (agent project): set the same secret and NOLON's client id in the agent's settings.

The bot's polling stays the fallback for decisions; stage notices come only from these events.

## 5. Agent impact (erp-agents)

- `customer-agent/turn/request-facts.ts` lists NOLON's stage codes (`LEFT_ORIGIN_STAGES`, `BEFORE_LEAVING_STAGES`,
  `DESTINATION_CITY_STAGES`). The three new codes must be added there **before** 15-2 reaches the servers:
  LOADED before leaving; IN_CUSTOMS after leaving; OUT_FOR_DELIVERY after leaving, with the destination city.
- `whatsapp/erp-events.ts stageText` builds the stage notice from a fixed template. ⭐ The bot should hand the stage,
  city and number to the model as facts and let it write the notice (owner rule: no rigid canned replies).
- A pallet adds no new event: its moves are ordinary status changes.
- Note for the agent project: `/mnt/project-files/agent/agent-notes/customer-notices-every-stage-2026-11-08.md`.

## 6. Steps (one PR each, fast tests before one push, reviewer OK + all checks green before merge)

| Step | What                                                                                                    | Migration                                      |
| ---- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 15-1 | This plan                                                                                               | none                                           |
| 15-2 | Three new customer stages and the new mapping; OUT_FOR_DELIVERY shows the destination city              | rows in existing tables: owner OK + label      |
| 15-3 | Pallets: tables, service, screens, label with QR, put in container/trip, move all inside, behind switch | new tables only (additive)                     |
| 15-4 | "On hold" notice to the customer (`shipment.needs_staff`), behind a switch                              | none                                           |
| 15-5 | Notices for customers booked by staff (not from the bot), once the bot can reach them                   | later plan (needs a per-customer event stream) |

Order: 15-3 does not depend on the bot and is built first. 15-2 merges after the agent project deploys the new stage
codes (rule: the agent compat change goes first). Turning notices on (section 4) can happen at any time; it is a
switch, not code.

## 7. Amendment for 15-2 (owner, 2026-11-10)

The owner approved the bookings bot's customer journey step by step on 2026-11-10. It names the stages the bot tells
the customer about: collection hub, port of loading, on board (the vessel's name), port of arrival (its name), customs,
distribution hub, road, city office, delivery. 15-2 follows it:

- **Two new stages, not three**:
  - `LOADED` «في ميناء الإرسال» (status LOADED), right after AT_ORIGIN_HUB;
  - `IN_CUSTOMS` «تحت التخليص الجمركي» (status CUSTOMS_IN_PROGRESS), right after AT_PORT.
  - OUT_FOR_DELIVERY stays inside AT_DESTINATION_HUB, as today.
- AT_PORT is renamed «وصلت ميناء الوصول» / "Arrived at the port of arrival", since customs now has its own stage.
  As in section 2, the rename applies only while the row still carries its seed name. A status moves only while it
  still maps to its seed stage, so an Administrator's own mapping is kept.
- **The vessel and the ports in the read**: a request's `shipment` gains three fields:
  - `vessel`: the shipment's own vessel, else its container's;
  - `loadingPort` and `arrivalPort`: the container's port of loading and port of discharge, by their own names.

  The container is the newest one the shipment is in that is not cancelled. Any field without a value is null. The
  bot names them as facts and writes its own words.

- Agent impact, unchanged in kind: add `LOADED` to `BEFORE_LEAVING_STAGES` and `IN_CUSTOMS` to `LEFT_ORIGIN_STAGES` in
  `request-facts.ts`. This goes first, before 15-2 reaches the servers. The three new fields are optional for the
  bot: its schema ignores fields it does not know.
