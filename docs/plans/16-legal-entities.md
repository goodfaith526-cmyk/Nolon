# 16. Legal entities: one set of books per company, in its own currency

The owner asked on 2026-11-09 for a review that makes Nolon ready for «a company born giant». The review is
`/mnt/project-files/nolon/reviews/مراجعة-شاملة-شركة-عملاقة-2026-11-09.md` (main 4f53e88). Its first three
findings (م1 to م3) are about the books, and the owner said «ابدا» (2026-11-09 23:33). This is the plan. The
build comes in the PRs of section 9, each one after this plan has the reviewer's OK.

**Group structure (owner correction, 2026-11-10 02:12):** «الشركة الام القابضة حتكون مسجلة في هونغ كونغ،
السعودية حتكون وكيل، الصين فيها وكيل، والامارات وكيل، ومصر والسودان». The parent is a holding company registered
in Hong Kong. Saudi Arabia, China, the UAE, Egypt and Sudan are its agents (وكلاء). Section 1 models that.

**Why now.** Posted journal entries never change (AGENTS.md rule 3). Whatever structure the first real entry is
posted in, it stays in forever. So this lands **before the opening balances and the first real entry in
production**, not after go-live.

## 0. What is there today (main 4f53e88)

| #   | Fact                                                                                                                                                                                       | Where                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| F1  | There is no company above the branches. DXB (UAE), JED (KSA) and PTS, ATB, KRT (Sudan) post into one chart, one set of posting roles and one calendar of periods.                          | `Branch` model; `AccountMapping` keyed on `role` only                                        |
| F2  | A period is one row per (year, month) for everybody. Closing October closes it in every country at once; a late Sudan entry cannot be posted after Dubai has closed.                       | `FiscalPeriod @@unique([year, month])`; `periods.service.ts:59`                              |
| F3  | A line holds its amount in the transaction currency and in USD. It has no amount in the company's own currency (SAR for Jeddah, AED for Dubai). An entry must balance in USD only.         | `JournalLine.debit/credit/debitUsd/creditUsd`; trigger in `20261003181158_.../migration.sql` |
| F4  | Every financial report is in USD.                                                                                                                                                          | `trial-balance.service.ts` «Trial balance in USD», `ledger-reports.service.ts`               |
| F5  | Financial document numbers come from one counter per type for all branches: Dubai's and Jeddah's invoices share `NOL-INV-2026-…`.                                                          | `common/numbering.ts`; `nextSequenceValue(tx, 'INVOICE', year)`                              |
| F6  | Every entry already sits in one branch: all automatic rules and manual journals write lines in the entry's branch. So the company of an entry is well defined once a branch has a company. | `auto-journal.service.ts` (`branchId:` of the source document), `manual-journals.service.ts` |

## 1. Legal entities

**⭐ A new master `legal_entities`. Every branch belongs to exactly one. The entity is the unit of books:
currency, periods, numbering and, later, tax. The Hong Kong holding is the group's parent entity, and every
country agent that runs branches in Nolon is an entity of its own, with its own books.**

**Why agents are entities and not partners (decision ⭐).** An agent here runs whole branches. It receives the
goods, collects cash in its own currency, pays local costs, has its own staff, and closes its own months. That
needs a ledger, periods and its own invoice numbers, which a partner record does not have (`Partner` holds
commission terms and a statement, and no books). Modelling agents as entities also keeps one agent's books apart
from another's, while the holding sees the whole group in USD. The holding's own share of each agent's business
(agency fee, profit share or recharge) is a movement between two entities: plan 17 (section 6) builds it. If one
day an agent is a small third party that keeps its books outside Nolon and only sends shipments, it stays a
`Partner` with commissions, as outlets and consolidators are today. The choice is per agent.

- `legal_entities`: `id`, `code` (2 to 4 capitals, unique, used in numbers), `name_en`, `name_ar`,
  `country_code` (ISO 3166-1), `kind` (`HOLDING` or `AGENT`), `parent_id` (the holding, null only on the
  holding; one level, checked), `functional_currency` (FK to `currencies`), `tax_registration_no` (nullable, for
  a later tax plan), `is_active`, timestamps. Exactly one active `HOLDING` (partial unique index).
- `branches.legal_entity_id` (FK, NOT NULL after the migration fills it).
- `journal_entries.legal_entity_id`: copied from the branch when the draft is written, and checked by the
  trigger to equal the branch's entity. Reports filter on it without a join, and the history keeps the entity it
  was posted in.
- **Locks, in the database (trigger):** an entity's `functional_currency` cannot change once it has a posted
  entry; a branch's `legal_entity_id` cannot change once the branch has a posted entry. Before that, both are
  free, so the accountant can fix the setup.
- One chart of accounts stays shared by the group (one code per account, as today). An account may be limited to
  one entity (`accounts.legal_entity_id`, nullable, like `branch_id` today); a line refuses an account limited to
  another entity.
- Posting roles: `entity_account_mappings(legal_entity_id, role, account_id)` overrides `account_mappings` for
  one entity; a role with no override uses the group account, as today. Same for charge type postings later,
  only if the accountant asks.
- Screen: Settings → Legal entities (list, add, edit), and the entity on the branch form. Permission
  `legal_entities:manage` (Administrator by default), in `ar.json` and `en.json`.

**Entities** (the accountant can change currencies and names until the first real posting):

| Code | Kind    | Country | Branches today | Functional currency                                                                             | Made by       |
| ---- | ------- | ------- | -------------- | ----------------------------------------------------------------------------------------------- | ------------- |
| HK   | HOLDING | HK      | none yet       | **USD ⭐** (the group reports in USD already; HKD is pegged to USD; the accountant decides)     | the migration |
| SA   | AGENT   | SA      | JED            | SAR                                                                                             | the migration |
| AE   | AGENT   | AE      | DXB            | AED                                                                                             | the migration |
| SD   | AGENT   | SD      | PTS, ATB, KRT  | **USD ⭐** (SDG loses value fast and Nolon already prices Sudan in USD; the accountant decides) | the migration |
| EG   | AGENT   | EG      | none yet       | EGP                                                                                             | the screen    |
| CN   | AGENT   | CN      | none yet       | CNY                                                                                             | the screen    |

The migration makes the HK holding, then one agent entity per distinct `branches.country_code`, named after the
country, with its parent set to HK and the currency above (AED, SAR, else the branch's default currency, except
SD = USD). It is plain data, so a test database with other branches still migrates. Egypt and China have no
branch yet: their entities are added on the screen together with their first branch (a branch needs an entity),
and their currencies must exist in the currencies master. The holding posts only once it has a branch of its own
(for example `HKG`), added on the screen when the holding starts to book; entries stay branch-owned (rule 2).

## 2. Three amounts per line: transaction, local, USD

**⭐ Each line keeps its amount in the transaction currency (as today), in the entity's functional currency
(new, the statutory book) and in USD (as today, the group's reporting currency). An entry must balance in local
and in USD. The local book is the book of record.**

- New nullable columns on `journal_lines`: `debit_local`, `credit_local` (`Decimal(18,4)`), `local_currency`
  (char 3), `local_fx_rate` (`Decimal(18,8)`, entity currency units per 1 USD on the entry's rate date).
- Rule, in `journal-math.ts` only (rule 1: rounding in one place):
  - line currency = entity currency → `local = amount`, exactly;
  - otherwise → `local = round(amountUsd × localFxRate, decimals of the entity currency)`;
  - a `LineSpec` may carry `amountLocal`, as it carries `amountUsd` today, for lines that clear an earlier
    document at that document's own value (a receipt clearing an invoice, a payment clearing a bill).
- Documents that carry a rate today also carry the entity rate they were posted at, so clearing is exact:
  `entity_fx_rate` (nullable) on customer invoices, receipts, credit notes, supplier bills, supplier payments,
  expenses, trip expenses. Allocation rows read it the way they read `invoiceFxRate` today.
- **Rounding.** Today a few cents of USD rounding go to the ROUNDING account. The same happens in local, on the
  same rule: at most one minor unit per line, where the minor unit comes from the entity currency's decimals in
  the currencies master (never a constant like today's USD `ROUNDING_PER_LINE = 0.01`).
- **Realised FX difference in two books.** A receipt can make a gain in USD and none in SAR (or the reverse).
  ⭐ The journal service adds **adjustment lines** that fit the existing `journal_lines_side_check` as it is (no
  widening; rule 3 checks are never loosened):
  - a **local-only** adjustment is a line in the entity's currency, amount > 0, USD = 0 (through `amountUsd`);
  - a **USD-only** adjustment is a USD line, amount > 0, local = 0 (through `amountLocal`).
    In an entity whose currency is USD, local and USD never differ, so neither is needed.
  - Each line gets `line_kind` (`NORMAL` by default, or `ADJUSTMENT`), set only by `JournalService`. Ordinary
    lines can legitimately reach 0.00 USD today (`toUsd` rounds to cents: 0.01 SAR, or a few SDG, is 0.00 USD,
    for example a small share in `containerCostAllocated`), so a line is never recognised by its zeros.
  - The **`journal_lines_guard` trigger** checks that an `ADJUSTMENT` line is on an account mapped to FX_GAIN,
    FX_LOSS or ROUNDING (group mapping or the entity's override). A CHECK cannot read mappings, hence the trigger.
    `NORMAL` lines keep today's rules, zeros included.
- **New CHECKs on the local columns**, like `journal_lines_rate_check` does for USD: local amounts are ≥ 0 and
  on the same side as the line (a debit line has `credit_local = 0`, and the reverse); `local_fx_rate > 0`; and
  `currency = local_currency` ⇒ `debit_local = debit AND credit_local = credit`, exactly.
- **The trigger** (posting) also checks: the entry's entity equals its branch's entity; **every line's branch
  belongs to the entry's entity** (today `LineSpec.branchId` is per line and only service code keeps it equal to
  the entry's branch, for example the trip accrual clearing line in `auto-journal.service.ts:1119`, guarded by
  `supplier-bills.service.ts:916`); every line has local amounts and its `local_currency` is the entity's
  currency; and local debits = local credits. `JournalService.balance` checks the same before writing, for a 400
  instead of the database error.
- **Reversals copy, never recompute.** `JournalService.reverse` mirrors the original's lines with their local
  columns exactly (debit and credit swapped), never at today's rate, so a reversal cancels the original in all
  three amounts.
- **Old lines** (posted before this plan, staging trial data) keep local = NULL. They are never touched (rule
  3). ⭐ The posting trigger allows NULL local on exactly one kind of entry: one whose `reversal_of_id` points to
  an entry whose lines have NULL local, and then on all its lines. So cancelling a pre-plan invoice, receipt,
  bill or payment on staging still works, and nothing new can be posted without local amounts. A report in local currency that would include them refuses with «entries before legal entities: report in
  USD». Production must reach this plan before its first real entry (section 8).

## 3. Periods per entity

**⭐ Keep the group calendar (`fiscal_periods`). Add `entity_period_closures(legal_entity_id, period_id,
closed_at, closed_by_id)`. A period is open for an entity unless the group period or that entity's period is
closed.**

- Close: `POST /accounting/periods/:id/close` takes `legalEntityId` (required once more than one entity
  exists). Same rules as today, counted in that entity: ended, no drafts in that entity.
- The group close (today's `status = CLOSED`) stays, for the group accountant: it closes every entity.
- `PeriodsService.requireOpen(tx, date, legalEntityId)`, and the trigger checks the closure table too.
- Reopening is out of scope (finding م11, a later plan); the table makes it a delete plus an audit row.
- The fiscal year is the calendar year for every entity (decision ⭐; a different year start is a later plan
  only if an entity needs it).

## 4. Numbering per entity

**⭐ Financial documents count per (entity, year), with the entity code in the number: `NOL-SA-INV-2026-000001`.
Operational numbers (BK, CS, QT, trips, POD, shipments, route numbers) stay one counter for the group, as the
owner decided.**

- Financial types: INVOICE, OPENING_INVOICE, CREDIT_NOTE, RECEIPT, JOURNAL, SUPPLIER_BILL, OPENING_BILL,
  SUPPLIER_PAYMENT, EXPENSE, TRIP_EXPENSE, PARTNER_STATEMENT.
- No schema change: `number_sequences.period_key` (varchar 10) becomes `SA-2026`. `formatDocumentNumber` takes
  the entity code. The longest prefix is three letters (`OBI`, `OBS`, `PST`, `TEX`), so with a 4-letter entity code the
  longest number is `NOL-ABCD-OBI-2026-000001` (24 characters), inside `varchar(30)`.
- Old numbers stay as they are (they are unique and never reused, because the new ones carry the entity code).
- It also ends one hot row per type for the whole group: Dubai and Jeddah invoices no longer wait on each
  other's counter.

## 5. Reports

- Trial balance, income statement, balance sheet, general ledger, AR/AP aging and cash movement take
  `legalEntityId` and `currency = LOCAL | USD`. LOCAL needs exactly one entity (AED and SAR are never summed).
  USD works across entities, as today.
- Branch filtering stays (rule 2): a user sees the lines of their branches only; an entity report for a user who
  holds only some of its branches shows those branches and says so.
- Excel exports gain the entity and the currency in the title row.

## 6. What does not change, and what is out of scope

- **Intercompany between the holding and the agents, and between agents, is plan 17, the next plan after this
  one (⭐).** With a holding and five agents it is no longer a side case: each agent owes the holding its share
  of the business, and shipments cross agents. Shared shipments cross branches and, with this plan,
  entities. For example `containerCostAllocated` (`auto-journal.service.ts:908-955`) books a container's cost in
  the container's branch against every shipment in it, including other branches' shipments; revenue billed in one
  entity for a leg done by another is the same. With one entity per entry every book balances, but a JED
  container carrying PTS shipments leaves Sudan's shipment costs in SA's profit and loss with no recharge. Plan
  17 adds due-to and due-from accounts between entities, the agent's share to the holding, recharges, paying in
  another country (review finding م7), and the eliminations that a consolidated group report in USD needs.
  Until then, each entity's books balance on their own and profit per shipment stays a group report in USD.
- **Unrealised FX revaluation is out of scope (a later plan, review finding م9).** Open USD receivables and
  payables in an SAR or AED book need revaluing at month end under IFRS (IAS 21). The accountant should know it
  is not covered yet.

- Rule 3 triggers are extended, never dropped, disabled or bypassed. Posted rows are never updated; the new
  columns are filled for new entries only.
- Customers stay central with no branch (rule 2 exception). Documents stay branch-owned.
- Prices, invoices and receipts keep their own currency; the branch's `default_currency` keeps driving pricing.
- Agent (erp-agents): it reads numbers as strings and never parses them (checked: only test fixtures contain
  `NOL-INV-…`). No compat PR is needed first. A note for the agent project goes with 16-3.

## 7. Tests (rule 7)

- Unit: `journal-math` local rule, local rounding line with the master's decimals, local-only and USD-only
  adjustment lines, clearing with `amountLocal`, reversal copying local columns.
- Integration, against PostgreSQL, including negative cases: unbalanced in local (trigger refuses); line with an
  account limited to another entity; a second active HOLDING, or an agent with no parent or with an agent as
  parent (refused); entity currency change after a posting (refused); branch moved to another
  entity after a posting (refused); posting into a period closed for that entity while another entity is open;
  `ADJUSTMENT` line on a non-FX account (refused by the lines trigger); a `NORMAL` line worth 0.00 USD on a
  cost or revenue account (still posts); local amounts on the
  wrong side, or different from the amount on a line in the entity's currency (refused by the CHECKs); a line in
  a branch of another entity (refused by the posting trigger); reversing a pre-plan entry (posts, local NULL);
  a new entry with NULL local that is not such a reversal (refused); reversing a post-plan entry (local columns
  mirrored exactly); local report over pre-plan lines (refused);
  wrong-branch user on an entity report; numbering per entity under two concurrent transactions.

## 8. Production gate

Before the opening balances in production: this plan's PRs merged and deployed, the accountant confirms the
entities and their currencies (section 1 table), and a read query shows `journal_entries` in production holds
no trial entries (if it does, the go-live plan starts production from a fresh database, already planned for real
data).

## 9. Build, in order

| PR   | Content                                                                                                                                                                                       | Migration                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 16-1 | `legal_entities` (HK holding + agents), `branches.legal_entity_id` filled + NOT NULL, `journal_entries.legal_entity_id`, locks, screen, permission, entity account mappings                   | **Non-additive** (branches NOT NULL, accounting table): owner OK + label     |
| 16-2 | Local amounts: columns, `journal-math`, `entity_fx_rate` on documents, adjustment lines, local CHECKs, trigger: line entities + local balance + pre-plan reversals, every auto rule passes it | **Non-additive** (accounting tables, new CHECKs, triggers): owner OK + label |
| 16-3 | Periods per entity (closure table, trigger, close screen), numbering per entity, reports LOCAL/USD + entity filter, agent note                                                                | **Non-additive** (trigger on journal entries): owner OK + label              |

Owner OK is needed once per PR for its migration (AGENTS.md rule 4). Backups: trial data only, so no backup
ceremony (owner rule 2026-10-28); production must take its backup before 16-1 if it already holds anything real.

## 10. Questions for the NOLON accountant (they override the ⭐ choices)

1. Is each agent a company owned by the Hong Kong holding (a subsidiary), or an independent company under an
   agency agreement? (The books are the same in Nolon; plan 17's share rule and the group report depend on it.)
2. Who invoices the customer: the agent in its country (⭐ assumed), or the holding?
3. What does each agent owe the holding: a fixed fee, a percentage of revenue, or the profit?
4. In which currency is each company's official book kept (Hong Kong: USD or HKD; Sudan: USD or SDG)?
5. Does any company need a fiscal year that does not start in January? (Hong Kong companies often close on
   31 March.)
