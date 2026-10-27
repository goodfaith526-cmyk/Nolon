# Plan: shared-container space left, route-coded LCL numbers, shipment keeps the booking number

Date: 2026-10-27. Source: client WhatsApp (Musab, Shaker), 27 Oct 2026. Plan only; nothing is built
until Codex reviews this plan and the owner answers the questions in section 5 (س1-س6 = Q1-Q6).

Base: `main` 4300b72. Open PRs touching the same areas: #109 (status history, consolidations close
rules) and #104 (status locks). This plan does not change status flows, so it does not overlap them;
whichever merges second rebases.

## 1. Shared container: space left while it fills (Musab)

Today: `container_types` (20GP, 40GP, 40HC, OTHER) has no capacity. The container page lists its
shipments with their weight and CBM (`consolidations.service.ts`, `volumeCbm`/`weightKg` summed from
shipment items) but shows no total against a limit.

Change:

- `container_types` gets two nullable columns: `max_volume_cbm Decimal(18,4)` and
  `max_payload_kg Decimal(18,4)` (usable capacity, not the nominal inside volume). Additive. Both
  editable in the existing master-data screen (Admin only, as today). `OTHER` stays empty.
- Values for the three standard types (Q1). Setting them on existing rows is an `UPDATE` on an
  existing table, so that one migration is **not additive** under rule 4: it needs the owner's OK and
  the `migration-ok-<digest>` label. If the owner prefers, the columns ship empty and the admin types
  the numbers; then the migration is purely additive.
- `GET /consolidations/:id` returns a `capacity` block computed in the service, all Decimal strings:
  `maxVolumeCbm`, `maxPayloadKg` (null when the type has none), `usedVolumeCbm`, `usedWeightKg`,
  `remainingVolumeCbm`, `remainingWeightKg` (may be negative), and `incomplete`: the shipment numbers
  with no CBM or no weight on any cargo line. Missing values are never counted as zero silently:
  the total is labelled incomplete and the shipments are listed (same rule as the business-model
  plan: missing = «غير مكتملة», not zero).
- Container page (`ConsolidationDetail.tsx`): a panel at the top, two bars (CBM, weight) with used /
  capacity / left and a percentage; amber at 90 %, red when over. When the type has no capacity:
  "set the capacity of this container type" with a link for admins.
- Adding a shipment: the picker shows each candidate's CBM and weight and "left after adding".
  Going over capacity is a **warning, not a block** (Q2): real loading depends on stacking and the
  client's figures are estimates; the warning names both numbers.
- Applies to OPEN containers and also shows (read-only) on closed ones, from the frozen basis.

Tests: unit for the capacity maths (Decimal, rounding at display only, negative remaining, missing
lines); integration: other branch gets 404 on the container (existing rule), capacity null when the
type has none, incomplete list, over-capacity add returns the warning and still saves.

## 2. LCL reference: origin + destination letters + a number (Musab)

"DXB-KRT-0001": route letters, then a counter per route.

Format: `<ORIG>-<DEST>-<NNNN>`, four digits, zero-padded, a fifth digit after 9999 (same idea as the
short BK numbers). No year, never resets (Q5). Counter per route pair through the existing
`number_sequences` table, inside the creating transaction, so numbers are gapless and concurrent
creators are serialised by the row lock: `doc_type = 'LCL'`, `period_key = 'DXB-KRT'`
(`period_key` is `VARCHAR(10)`; letters are capped at 3 or 4 so the key fits, see below).
Uniqueness: the record's `number` column is already `UNIQUE`; DXB-KRT and KRT-DXB are different
counters.

Where the letters come from: a location code is a UN/LOCODE (AEJEA Jebel Ali, AEDXB Dubai, SAJED,
SDPZU Port Sudan, SDKRT). The client's letters are their branch codes (DXB, JED, PTS, ATB, KRT), and
PZU is not PTS, JEA is not DXB. So `locations` gets a nullable `short_code VARCHAR(4)` (letters only,
upper case), editable in master data. The letters used are: the location's `short_code`, else its
city's `short_code`, else the last three letters of its LOCODE. Additive column; filling it for the
six seeded locations (AEJEA, AEDXB -> DXB; SAJED -> JED; SDPZU -> PTS; SDATB -> ATB; SDKRT -> KRT) is
an `UPDATE`, so same rule as section 1, Q6 (owner OK + label, or admin fills it).

Which record gets this number (Q3): the shared container (today `NOL-CON-2026-000001`), the LCL
booking (today `BK00001`), or both. The container's route is fixed when it is created; a booking's
route can still change while it is a draft, and its number would then keep the old letters (the
number is not re-issued, a number never changes once given).

Only new records: existing containers/bookings keep their numbers (Q4).

Tests: format, per-route counter, two routes, concurrent create (no duplicate), fallback letters,
short code validation (letters, 2-4), unique clash impossible across routes.

## 3. Shipment keeps the booking number (Shaker)

Today: confirming a booking creates the shipment with a new number `NOL-SHP-<year>-<6 digits>`
(`ShipmentsService.createForBooking`, sequence `SHIPMENT`).

Change: the new shipment's `number` is the booking's `number`. One shipment per booking
(`shipments.booking_id` is unique), so the number stays unique among shipments. The `SHIPMENT`
sequence is no longer used for new shipments. No migration (`shipments.number` is `VARCHAR(30)`).
Old shipments keep their `NOL-SHP-...` numbers, QR codes, printed papers and tracking links (Q4).
Tracking links and QR codes use a random token, never the number, so nothing breaks there.

Effects checked:

- NOLON search, invoices, statements, prints and reports show `shipment.number` as a string: no
  format assumption, nothing to change. Searching `BK00012` will now find the booking and its
  shipment, which is what the client wants.
- Public tracking by reference + last 4 phone digits: reference length 5-30, `BK00012` passes. A
  short sequential number is easier to guess than the yearly one, but the lookup still needs the
  phone's last 4 digits and is rate-limited per reference and per IP (unchanged). Placeholder text in
  `PublicTracking.tsx` changes to the new form.
- Customer Service API (`/customer-service/shipments/:number`): accepts any 1-30 character
  reference; unchanged.
- **Agent (erp-agents), breaking**: `connectors/nolon/nolon-customer.ts` validates shipment numbers
  with `/^NOL-SHP-\d{4}-\d{6}$/` on the tool input _and_ on NOLON's response, and finds shipment
  references in customer messages with an `SHP-` pattern; `nolon-status.ts` matches `shp-YYYY-...`
  in staff messages. A shipment numbered `BK00012` (or `DXB-KRT-0001`) would fail the response
  schema, so the customer WhatsApp tool would refuse every new shipment. Per the compat rule, an
  erp-agents compat PR merges **first**: accept old `NOL-SHP-...` and the new booking forms
  (`BK\d{5,}`, and `[A-Z]{2,4}-[A-Z]{2,4}-\d{4,}` if Q3 picks bookings), in input, response and
  message matching, with tests. Then this NOLON part merges. Agent draft routes are unchanged (no new
  field in any draft route); the new capacity block and `short_code` are response/master-data
  additions the agent's non-strict response parsing ignores.

Tests: integration: confirm booking -> shipment number equals booking number; old shipments
untouched; a booking created by an approved draft still gets its shipment with the same number;
cancelled-and-reconfirmed path (a booking has at most one shipment, unchanged).

## 4. Order of PRs

1. PR-A (NOLON): shipment keeps the booking number. Waits for the erp-agents compat PR.
2. PR-B (NOLON): container capacity panel (+ capacity columns migration).
3. PR-C (NOLON): route-coded LCL numbers (+ `short_code` migration), after Q3.
4. erp-agents compat PR: number patterns, merged before PR-A (and before PR-C if bookings).

## 5. Questions for the owner (اسئلة للمالك)

**س1: سعة الحاويات بالأرقام دي؟** (المساحة الفعلية للتحميل، مش المساحة الداخلية الكاملة)

- ⭐ أ) 20 قدم: 28 متر مكعب، 28,000 كجم. 40 قدم: 58 متر مكعب، 26,500 كجم. 40 عالية: 68 متر مكعب، 26,500 كجم. نكتبها في التحديث (محتاج «موافق» منك لأنو بيعدّل جدول موجود)، والأدمن يقدر يغيّرها بعدين.
- ب) نخليها فاضية والأدمن يكتب الأرقام بنفسه.

**س2: لو الشحنة الجديدة بتزيد الحاوية فوق سعتها؟**

- ⭐ أ) تحذير بس ويحفظ (التحميل الحقيقي بيختلف).
- ب) يمنع الإضافة.

**س3: الرقم بحروف المنشأ والوجهة (DXB-KRT-0001) يكون لياتو؟**

- ⭐ أ) الحاوية المشتركة نفسها (مسارها ثابت من أول ما تتعمل).
- ب) حجوزات LCL (والشحنة بتاخد نفس الرقم حسب طلب شاكر). لو المسار اتغيّر في المسودة، الرقم بيفضل بالحروف القديمة.
- ج) الاتنين.

**س4: الأرقام القديمة؟**

- ⭐ أ) تفضل زي ما هي (مطبوعة ومرسلة للعملاء). الجديد بس بالنظام الجديد.
- ب) نغيّرها كلها (ما بننصح: الورق المطبوع والرسائل القديمة بتبقى غلط).

**س5: العداد يبدأ من جديد كل سنة؟**

- ⭐ أ) لا، مستمر (DXB-KRT-0001 ... 9999 ثم 10000).
- ب) أيوة، والسنة تدخل في الرقم (DXB-KRT-26-0001).

**س6: حروف المدن (دبي/جبل علي = DXB، جدة = JED، بورتسودان = PTS، عطبرة = ATB، الخرطوم = KRT)؟**

- ⭐ أ) نكتبها في التحديث (محتاج «موافق» لأنو بيعدّل جدول موجود)، والأدمن يزيد لأي مدينة جديدة.
- ب) الأدمن يكتبها بنفسه.
