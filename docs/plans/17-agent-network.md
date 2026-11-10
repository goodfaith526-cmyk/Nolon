# 17. The agent network: revenue split, intercompany and monthly netting

The owner approved the agency-network model on 2026-11-10 («تمام اعمل تصور كامل», 02:29). Plan 16 builds the
entities: the Hong Kong holding and one entity per country agent, each with its own books. This plan is the money
between them. It is the complete design; the build comes in section 9, each PR after this plan has the reviewer's
OK.

## 1. The model in one page

| Who                            | Owns                                                       | Books                                            | Sees                                                                                              |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **HK holding** (Nolon group)   | the brand, the customer file, the network rules            | USD, its own entity (plan 16)                    | every operation of every agent, every agent's books (read), group reports, the netting            |
| **Country agent** (e.g. مرافي) | its local company, its staff, its local costs              | its own currency, VAT, invoice numbers (plan 16) | its own operations only; any network customer (`customers:view`, no export); its own HK statement |
| **Customer**                   | nothing in the network; served by whichever agent it meets | none                                             | its own bookings and documents (bot, tracking)                                                    |

- **Customers and the brand are HK's** (owner, 2026-11-10 02:25), and **shared** across the network (02:28). An
  agent serves them and never takes them along (plan 16, section 1).
- **Every shipment between two countries is shared work.** The origin agent receives and sends the goods, the
  destination agent clears and delivers them. The revenue is split between them by a rule per lane.
- **HK is the clearing house.** Every agent has one intercompany account, with HK. Money between agents always
  goes through HK, so each agent settles one balance a month, not one per partner (the way an airline clearing
  house works). This is hub-and-spoke on purpose: with five agents it is five balances instead of up to twenty.
- **The intercompany accounts are kept in USD**, the network currency, in every book. An agent's local book
  carries the local amount beside it (plan 16), so the agent bears its own exchange difference, and HK's balances
  add up without conversion.

## 2. Who invoices the customer

- ⭐ **The agent where the customer pays issues the invoice**, in its own entity, currency, VAT and numbers.
  Usually the sender pays at origin (prepaid). When the receiver pays on arrival (collect), the destination agent
  invoices. The booking has no such field today: 17-2 adds `bookings.payment_terms` (`PREPAID` by default, or
  `COLLECT`), carried to the shipment, and invoicing checks the invoicing branch against it. This also closes review finding م7 (paying in another country): the paying side is just the other
  agent.
- The invoicing agent books the **whole** revenue. The split (section 3) then moves the other agent's share to it
  through HK.

## 3. The revenue split per shipment

- `lane_splits(origin_country, destination_country, basis, origin_pct, per_unit_amount, currency, valid_from,
valid_to)`, with `basis` `PCT_OF_FREIGHT` (the origin keeps `origin_pct`, the destination gets the rest) or
  `PER_UNIT` (the destination gets a fixed amount per chargeable unit: barrel, carton, CBM, kg). Periods do not
  overlap per lane: an exclusion constraint on `(coalesce(origin_country, '**'), coalesce(destination_country,
'**'), daterange(valid_from, valid_to))`, so the default rows (no countries, sentinel `**`) cannot overlap each
  other either. CHECKs: `origin_pct` from 0 to 100, set only for `PCT_OF_FREIGHT`; `per_unit_amount > 0` and
  `currency` set only for `PER_UNIT`; both countries set or both null. ⭐ A group default row applies to any lane
  without its own: **60% origin / 40% destination of the freight revenue** until the owner sets real lanes.
- ⭐ A `PER_UNIT` share is **capped at the freight** of that invoice: the destination never gets more than the
  freight it shares, and the origin's share never goes below zero. The invoice approval shows a warning when the
  cap applies.
- **What is split:** freight charges only. Charges that one side alone performs stay with it (customs fees at
  destination, packing at origin, storage where it happens), by charge type: `charge_types.split_side` =
  `SPLIT`, `ORIGIN` or `DESTINATION`.
- **When:** at invoice approval, in the same transaction (AGENTS.md: writes that succeed or fail together), from
  the rule valid on the invoice date. A credit note reverses the split in proportion. A cancelled invoice
  reverses it whole.
- **Where it posts** (all automatic, one journal entry per entity, all in one transaction, from the auto-journal
  rules service, never by hand):
  - invoicing agent: Dr «other agent's share» (cost), Cr «due to HK»;
  - HK: Dr «due from invoicing agent», Cr «due to other agent»;
  - other agent: Dr «due from HK», Cr «network share revenue».
- **Which branches carry the entries:** the invoicing branch, the `HKG` branch of the holding, and the
  shipment's other branch from `ShipmentBranch` (its destination branch for a prepaid shipment, its origin branch
  for a collect one).
- **System postings, the one rule 2 exception (⭐).** The user who approves an invoice in Jeddah cannot write in
  `HKG` or in a Sudan branch. The split, fee and settlement entries in those branches are system postings from the
  auto-journal rules: recorded with the real user as actor and `posted_by_system = true` (a new column on
  `journal_entries`). They are never reachable from a user-facing write; the manual journal and every document
  route keep the plain rule 2 check.
- **A closed month in the other entity never blocks the payment (⭐).** Since 13-4, invoice approval is the window
  taking the customer's cash. If the month is closed in HK or in the other agent, that entity's split entry posts
  on the first day of its next open month (dated there, same `network_event_id`), and the invoicing agent's entry
  posts on the invoice date as usual. The statement shows the pair as «in transit» until both are posted. Nothing
  is refused.
- **One lock order across entities.** A split transaction locks per-entity numbering counters, period rows and
  intercompany balances in three entities. They are always taken in one global order, by `legal_entity_id`
  ascending, whatever the direction of the shipment, so an SA→SD and an SD→SA approval at the same moment cannot
  deadlock. The posting engine (17-1) takes all of them up front through one helper, as `lockActiveBranches` does
  for branches today.
- **Domestic shipments** (origin and destination in one agent) have no split.

## 4. The network fee to HK

From plan 16's `agency_agreements`, per agent:

- `REVENUE_SHARE_PCT`: the agent owes HK a percentage of its **net** revenue for the month, named by account:
  customer revenue (the charge types' revenue accounts) minus «other agent's share» (cost) plus «network share
  revenue». «Network share revenue» is not customer revenue, so it is counted once.
- `COMMISSION_PCT`: HK owes the agent a percentage (for an agent that only sells for the network).
- `FIXED_FEE`: a fixed monthly amount.

Posted once a month, on the last day, per agent: agent Dr «network fee» (cost), Cr «due to HK»; HK Dr «due from
agent», Cr «network fee revenue» (the reverse for a commission). A draft run shows every agent's amount before
HK's finance posts it.

## 5. Monthly netting and settlement

- **Network statement** (HK, per month): per agent, the USD balance on both sides (agent's «due to/from HK» and
  HK's «due from/to agent»), opposite signs, flagged when they differ (plan 16 rule), and the net: the agent pays
  HK, or HK pays the agent.
- **Settlement** on the agent's `settlement_day` (plan 16): a settlement document per agent with the transfer
  reference. Agent: Dr «due to HK», Cr bank; HK: Dr bank, Cr «due from agent» (the reverse when HK pays). A
  transfer in local currency converts at that day's rate; the difference is the agent's FX gain or loss (plan 16
  section 2), never HK's.
- **Period lock:** a month's split and fee entries are final once the netting is posted. A late credit note
  reverses its split in the next open month.

## 6. Tax per country

- ⭐ Tax lives in each agent's entity: VAT number (plan 16), a rate per charge type and destination (for example
  international transport zero-rated, local services at the standard rate), and a tax account. The invoice shows
  VAT on each line and in total, and the agent's legal name and VAT number as issuer under the Nolon brand.
- Starting standard rates (the accountant confirms each and the zero-rating of international transport):
  Saudi Arabia 15%, UAE 5%, Egypt 14%; Sudan, China and Hong Kong as the accountant gives them (Hong Kong has no
  VAT).
- The **network fee and shares between HK and an agent** are cross-border services. In Saudi Arabia and the UAE
  the local agent may owe VAT on them under reverse charge; the accountant confirms, and the fee entry then adds
  the reverse-charge lines.
- **E-invoicing** (ZATCA in Saudi Arabia, and the UAE's coming scheme) goes through an approved provider per
  country, connected to the agent's entity; it is a later plan, not built here.

## 7. Worked example: one barrel, Jeddah to Khartoum

Assumptions, for the arithmetic only: price 250 SAR (the real Jeddah barrel price), international transport
zero-rated (VAT 0), 1 USD = 3.75 SAR, lane SA→SD on the default 60/40 split, both agents on a 10% revenue share
to HK, trucking to Jeddah port 40 SAR, delivery in Khartoum 8 USD. Agent SA books in SAR, agent SD and HK in USD.

**Step 1. The customer books and pays in Jeddah.** Agent SA invoices 250 SAR; the customer pays cash at the
window.

| Book     | Debit       | Credit          | Amount  | USD   |
| -------- | ----------- | --------------- | ------- | ----- |
| SA (SAR) | Receivable  | Freight revenue | 250 SAR | 66.67 |
| SA (SAR) | Window cash | Receivable      | 250 SAR | 66.67 |

**Step 2. The split, at invoice approval.** SD's share is 40% of 250 SAR = 100 SAR = 26.67 USD.

| Book     | Debit                   | Credit                  | Amount                   |
| -------- | ----------------------- | ----------------------- | ------------------------ |
| SA (SAR) | Destination agent share | Due to HK (USD account) | 26.67 USD, local 100 SAR |
| HK (USD) | Due from SA             | Due to SD               | 26.67 USD                |
| SD (USD) | Due from HK             | Network share revenue   | 26.67 USD                |

**Step 3. Each side pays its own costs.**

| Book     | Debit         | Credit | Amount             |
| -------- | ------------- | ------ | ------------------ |
| SA (SAR) | Trucking cost | Cash   | 40 SAR (10.67 USD) |
| SD (USD) | Delivery cost | Cash   | 8.00 USD           |

**Step 4. Month end: the network fee (10% of each agent's net revenue).** SA's net is 250 − 100 = 150 SAR, so
15 SAR = 4.00 USD. SD's net is 26.67 USD, so 2.67 USD.

| Book     | Debit       | Credit              | Amount                 |
| -------- | ----------- | ------------------- | ---------------------- |
| SA (SAR) | Network fee | Due to HK           | 4.00 USD, local 15 SAR |
| HK (USD) | Due from SA | Network fee revenue | 4.00 USD               |
| SD (USD) | Network fee | Due to HK           | 2.67 USD               |
| HK (USD) | Due from SD | Network fee revenue | 2.67 USD               |

**Step 5. Netting and settlement.** HK's statement: SA owes 26.67 + 4.00 = **30.67 USD**; HK owes SD
26.67 − 2.67 = **24.00 USD**. HK keeps 30.67 − 24.00 = **6.67 USD**, its fees.

| Book     | Debit     | Credit      | Amount                         |
| -------- | --------- | ----------- | ------------------------------ |
| SA (SAR) | Due to HK | Bank        | 30.67 USD (115.01 SAR at 3.75) |
| HK (USD) | Bank      | Due from SA | 30.67 USD                      |
| HK (USD) | Due to SD | Bank        | 24.00 USD                      |
| SD (USD) | Bank      | Due from HK | 24.00 USD                      |

**Result.** Every intercompany account is back to zero.

| Book        | Revenue                 | Costs                               | Profit                               |
| ----------- | ----------------------- | ----------------------------------- | ------------------------------------ |
| SA          | 250 SAR                 | 100 share + 40 trucking + 15 fee    | **95 SAR** (25.33 USD)               |
| SD          | 26.67 USD               | 8.00 delivery + 2.67 fee            | **16.00 USD**                        |
| HK          | 6.67 USD fees           | none                                | **6.67 USD**                         |
| Group (USD) | 66.67 from the customer | 10.67 + 8.00 paid outside the group | **48.00 USD** = 25.33 + 16.00 + 6.67 |

The group report eliminates the shares and fees between group entities (they cancel out), so the group shows
only the customer's 66.67 USD and the 18.67 USD paid to outsiders.

## 8. Rules that keep it safe

- Split, fee and settlement entries come only from the auto-journal rules service, in one transaction across
  the entities involved (AGENTS.md: journal entries come from the auto-journal rules; writes that belong
  together run in one `prisma.$transaction`). Nobody posts to an intercompany account by hand; a manual journal
  that names one is refused.
- Every cross-entity posting carries one `network_event_id` on each of its entries, so the statement pairs them
  and compares each pair in its transaction currency, beside the USD balance check of plan 16.
- HK needs a branch to post (rule 2: entries are branch-owned): an `HKG` branch in the holding, created by
  17-1.
- Agents see their own entries only; HK finance sees all. A shared shipment is already visible to both its
  origin and destination branches (`ShipmentBranch`), so the destination agent sees the shipment it delivers,
  not the origin agent's invoice or books.
- Tests (AGENTS.md rule 7), including negatives: split posted in all three books or none; credit note reverses
  in proportion; a lane with no rule uses the default; a charge with `split_side = DESTINATION` goes whole to the
  destination; a manual journal on an intercompany account is refused; a split when HK or the other agent has closed the month
  (the payment posts, the closed side posts on the first day of its next open month, the pair shows in transit);
  SA→SD and SD→SA approvals at the same moment (no deadlock); overlapping default lane rows (refused); a `PER_UNIT`
  share above the freight (capped); an agent user cannot read HK's or another
  agent's entries; the worked example above as an integration test, every number in it checked.

## 9. Build, in order (after plan 16)

| PR   | Content                                                                                                                                    | Migration                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 17-1 | `HKG` branch, cross-entity posting engine (one transaction, global lock order, `network_event_id`, `posted_by_system`), intercompany guard | Non-additive (journal tables): owner OK + label                   |
| 17-2 | `lane_splits`, `charge_types.split_side`, `bookings.payment_terms`, split on invoice approval, reversal on credit note and cancel          | Non-additive (charge types, bookings, triggers): owner OK + label |
| 17-3 | Monthly network fee run (draft, then post)                                                                                                 | Additive unless it touches journal triggers                       |
| 17-4 | Network statement, settlement documents, period lock after netting                                                                         | Non-additive (lock trigger on journal postings): owner OK + label |
| 17-5 | Group report in USD with eliminations; effective-dated ownership for consolidation by share                                                | Additive                                                          |
| 17-6 | VAT per entity: rates by charge type and destination, tax account, VAT on invoices, reverse charge                                         | Non-additive (invoice lines): owner OK + label                    |

## 10. Choices made ⭐ (the owner or accountant can change them)

- HK is the only clearing counterparty (hub-and-spoke).
- Intercompany accounts in USD.
- The paying side's agent invoices; it books the whole revenue and the split moves the other share.
- Default split 60/40 of freight until real lanes are set.
- The split posts at invoice approval; the network fee posts monthly on net revenue.
- E-invoicing through an approved provider per country, later.
