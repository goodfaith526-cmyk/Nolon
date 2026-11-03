# 09. إكمال دورة بوت الحجوزات: من الطلب حتى التسليم (N-C1 إلى N-C9)

التاريخ: 2026-11-02. الحالة: **خطة**، ما في كود قبل موافقة Codex عليها.
المصدر: طلب مشروع المساعد (erp-agents) «إكمال دورة بوت الحجوزات» بتاريخ 2026-11-02، بعد تجربة البوت على staging.
الكود المرجعي: `main` = `8d2061f`. الخطة دي تكملة للخطة 04 (`04-customer-bot-contract.md`) و04a و08.

البوت نفسه في erp-agents. الخطة دي بتحدد **جهة نولون بس**. القرارات التجارية الموسومة ⭐ اختيارنا، وبتتسجّل في ملف
قرارات المالك (v7) ليراجعها مالك نولون.

**مراجعة 2 (بعد Codex على `6aa00ef`):** F161-1 إلى F161-7 معالجة في الأقسام 2 و3 و4 و5 و8 و9، والترتيب اتعدّل (مراجعة
المستندات قبل PDF، وتوافق المستهلك شرط قبل تفعيل الإلغاء)، وحماية الإشعار والتنزيل في القسمين 5 و7، وSQL كل migration
في القسم 10. الموافقة النهائية على SQL بتكون في PR كل بند.

**تعديل 3 (2026-11-03، طلب المساعد المحدّث):** بندين جداد من صاحب المشروع: N-C8 مكان التسليم في رد الموافقة (القسم 11)
وN-C9 الأغراض الما معيارية بصور وتقدير من الموظف (القسم 12). الترتيب في القسم 1 اتعدّل، والـSQL في القسم 10. 09-1 و09-2
اندمجوا (#163، #164).

## 0. الوضع اليوم (من الكود على `8d2061f`)

- `POST /cs/booking-requests` بشكلين: بالمعرّفات (`originId`، `category`، `quantity`، أبعاد اختيارية) وبالأسماء
  (`channel`، `origin/destination/kind` كـ `{ar,en}`، `quantity`). نوع واحد وكمية واحدة. أي شكل ممكن يجي مع ربط هوية
  موقّع (الخطة 08: `profileId` و`conversationId` وترويسات `X-Nolon-Channel-Assertion`)، وعندها المرسل = موضوع الهوية
  الموقّعة.
- `GET /cs/booking-requests/:id`: الحالة، `bookingNumber`، `customerReason`، `paymentInstructions`. القراءة لصاحب الطلب
  بنفس المفتاح (`X-Cs-Sender` أو token الزبون)؛ وطلب بالأسماء **بيقراهو أي مرسل بنفس المفتاح** (`botNames != null`).
- الموافقة (`POST /cs-booking-requests/:id/approve`) بتعمل **حجز مسودة** (`DRAFT`) بلا أسطر وبلا سعر؛ تأكيد الحجز
  (`BookingsService.confirmInTx`) خطوة منفصلة بتفحص البضاعة وبتعمل الشحنة.
- `BookingItem.quantity` عدد صحيح للطرود، والحجم والوزن في `volume_cbm` و`weight_kg`. كمية التسعير في الطلب ممكن تكون CBM
  أو كيلو (عشرية) حسب وحدة الفئة.
- ما في PDF من الخادم، ولا outbox، ولا إلغاء.
- العميل: الملف الموحّد (`customer_profiles`) بهوية القناة الموقّعة، وحساب لكل فرع (`customers`) بيتعمل من الملف عند
  الموافقة (`row.profileId` مقفول، `needsReview` بيمنع). كل قراءة للعملاء ومعاملاتهم مقيّدة بفروع الموظف.
- مستهلك العقد في erp-agents (`main` = `f64d7f4`، `connectors/nolon/nolon-customer.ts:353`): `requestReadAnswer` بيقبل
  الحالات الخمسة بس، فـ`cancelled` بتطلع خطأ `unavailable`. الحقول الزايدة في الرد بتتجاهل (الكائن ما `strict`).

## 1. الترتيب (كل بند PR براهو، مكدّسة)

| PR      | البند                                       | Migration | شرط قبل التفعيل                                     |
| ------- | ------------------------------------------- | --------- | --------------------------------------------------- |
| 09-1    | N-C1 إلغاء الطلب                            | إضافي     | PR مستهلك في erp-agents يقبل `cancelled` (القسم 9)  |
| 09-2    | N-C3 مراحل الزبون                           | إضافي     | —                                                   |
| 09-3    | N-C2 أكتر من صنف + سعر بأصناف               | إضافي     | —                                                   |
| 09-4    | N-C5 الإشعار (تيار أحداث واحد)              | إضافي     | عنوان استقبال معتمد + السر في البيئتين              |
| 09-5    | N-C7 مراجعة شكل المستندات وعقد البوليصة     | لا        | مراجعة Codex للتقرير                                |
| 09-6    | N-C4 البوليصة PDF                           | إضافي     | اختبار عرض عربي حقيقي على staging                   |
| 09-7a/b | N-C6 قاعدة العملاء المركزية (خطة 09b أولاً) | تحدده 09b | موافقة المالك الصريحة على توسيع الوصول (القسم 8)    |
| 09-8    | N-C8 مكان التسليم (القسم 11)                | إضافي     | —                                                   |
| 09-9    | N-C9 صور وتقدير الموظف (القسم 12)           | إضافي     | PR مستهلك في erp-agents يقبل `estimated` (القسم 12) |

**ترتيب البناء بعد تعديل 3:** 09-3 (الأصناف، ومعاها صنف `OTHER`) ← 09-8 ← 09-9 ← 09-4 ← 09-5 ← 09-6 ← 09-7. 09-8 بدري
لأنو البوت جاهز يعرض المكان، و09-9 قبل الإشعار عشان حدث `request.estimated` يدخل في نفس التيار.

N-C5 بعد N-C1 وN-C3 عشان أحداثهم، وبتيار تسلسل واحد قبل أي منتج أحداث (F161-4). مراجعة المستندات قبل PDF عشان القالب
والعقد يتثبتوا أولاً.

## 2. N-C1 إلغاء الطلب من الزبون

- **المسار:** `POST /cs/booking-requests/:id/cancel` بنطاق `cs:booking_requests:create`، جسم `{ reason?: string(1..300) }`.
- **إثبات الصاحب (F161-1):** الإلغاء **ما بينسخ** استثناء القراءة بالمفتاح. مقبول بس واحد من الاتنين:
  1. token زبون (`nolct_`) بنفس المفتاح، والطلب طلبو (`ownerRef = c:<customer>:<grant>`).
  2. ترويسات الهوية الموقّعة (الخطة 08، `X-Nolon-Channel-Assertion` على المسار والجسم، 5 دقائق) بنفس المفتاح، وموضوعها
     (`channel`، `subjectId`) **يساوي** مرسل الطلب المحفوظ (`sender_channel`، `sender_id`).
  - طلب ما ممكن نثبت صاحبو بالطريقتين (مثلاً طلب تيليجرام قديم اتعمل بدون ربط موقّع، مرسلو `tel:...`) =
    `403 OWNER_PROOF_REQUIRED`، والبوت بيحوّل الزبون للموظف. `X-Cs-Sender` براهو ما كفاية للإلغاء.
  - غير صاحب أو مفتاح تاني = `404` زي الطلب الما موجود.
- **داخل معاملة واحدة:** المفتاح بيتقرا تاني بقفل مشترك (نشط، عندو النطاق، الـ grant لسه صالح لو token)، وقفل الطلب
  `FOR UPDATE`، والفرع لسه في فروع المفتاح (غير كده `404`).
- **القواعد:**
  - `PENDING` أو `AWAITING_ROUTING` وما منتهي ← `CANCELLED` (قيمة enum جديدة)، `version + 1`، `cancelled_at`،
    `cancel_reason`، و`200 {requestId, reference, status:'cancelled', cancelledAt}`.
  - `CANCELLED` أصلاً ← نفس الرد `200` بنفس `cancelledAt`، بدون تدقيق تاني.
  - `APPROVED` ← `409 ALREADY_DECIDED` مع `status` و`cancelRequest: {requestedAt, closedAt}`. نفس المعاملة بتسجّل «طلب
    إلغاء» **مرة واحدة** (`cancel_requested_at`، `cancel_request_reason`)؛ التكرار ما بيغيّرو. الحجز ما بيتلغى؛ الموظف
    بيلغيهو بمسار الحجز الحالي، أو بيعلّم الطلب «اتعالج» (`POST /cs-booking-requests/:id/cancel-request/close {version}`،
    صلاحية approve في فرع الطلب، تدقيق).
  - `REJECTED` أو منتهي ← `409 ALREADY_DECIDED` و`cancelRequest: null`.
- **الموظف:** `CANCELLED` ما بيظهر في «مفتوح»، ومسارات التوجيه والرفض والموافقة بترجع `409` (قفل الطلب). فلترين جداد:
  «ألغاه الزبون» و«طلب إلغاء مفتوح». تفاصيل الطلب بتعرض الإلغاء أو طلب الإلغاء وزر «اتعالج».
- **التدقيق:** `audit_events` بالكيان `CS_BOOKING_REQUEST`، المصدر `API` بدون موظف، الإجراء `CANCELLED` (إلغاء) أو
  `UPDATED` بالحقل `cancelRequestReason` (طلب إلغاء)، ومعاهو المفتاح والصاحب في `changes`. إغلاق الموظف `UPDATED` بالمصدر
  `USER`.
- **القراءة:** `GET` بيضيف `cancelRequest: {requestedAt, closedAt} | null`، والحالة ممكن تكون `cancelled`.
- **التفعيل:** المسار ورا متغير بيئة `CS_BOOKING_CANCEL_ENABLED` (افتراضي `false`، `503 CANCEL_UNAVAILABLE`). ما في طريق
  تاني لحالة `CANCELLED`، فطول ما المتغير مقفول البوت القديم ما بيشوف `cancelled` أبداً (القسم 9).
- **اختبارات (integration):** مرسلين بنفس المفتاح: التاني = 404 حتى في طلب بالأسماء؛ `X-Cs-Sender` بلا توقيع = 403؛
  توقيع لمرسل تاني = 404؛ مفتاح تاني = 404؛ مفتاح اتسحب أو فرعو اتشال = 404؛ token الزبون = مقبول لطلبو بس؛ موافق عليه =
  409 + طلب إلغاء واحد بعد التكرار؛ مرفوض ومنتهي = 409 بلا طلب إلغاء؛ تكرار الإلغاء = نفس الرد وصف تدقيق واحد؛ خمسة
  إلغاءات متزامنة = صف تدقيق واحد؛ إلغاء متزامن مع موافقة = واحد بس بينجح؛ المتغير مقفول = 503.

## 3. N-C3 مرحلة الشحنة للزبون

- **ما بنغيّر `ShipmentStatus`.** جدولين master جداد:
  - `customer_stages (code PK, name_ar, name_en, sort_order, is_active)`، بذرة بمحطات المالك التسعة:
    `BOOKED` حجز مبدئي، `CONFIRMED` مؤكد لدى منفذ الشحن، `AT_ORIGIN_HUB` في مركز التجميع، `AT_SEA` في الطريق البحري،
    `AT_PORT` في الميناء بانتظار التخليص، `AT_CENTRAL_HUB` في مركز التوزيع المركزي، `ON_ROAD` في الطريق البري إلى
    «المدينة»، `AT_DESTINATION_HUB` في مركز التوزيع في مدينة المستلم، `DELIVERED` تم التسليم.
  - `shipment_status_stages (status shipment_status PK, stage_code FK)`، بذرة بالربط المقترح في الطلب ⭐. `ON_HOLD`
    و`CANCELLED` و`PARTIALLY_DELIVERED` ما مربوطين.
  - شاشة في البيانات الرئيسية (`master_data:update`، تدقيق) للأسماء والترتيب والربط. **`sort_order` للعرض بس**، ما
    بيقرر أي صلاحية ولا ظهور مستند (القسم 7).
- **المرحلة من الحالة الحقيقية (F161-2):** الحجز اللي بتعملو الموافقة مسودة، فـ«مؤكد» بتجي من الحجز ما من الموافقة:

  | حالة الطلب والحجز والشحنة                                 | `stage`                                   |
  | --------------------------------------------------------- | ----------------------------------------- |
  | `pending` / `awaiting_routing`                            | `BOOKED`                                  |
  | `approved` والحجز `DRAFT`                                 | `BOOKED` (لسه مبدئي)                      |
  | الحجز `CONFIRMED` أو `COMPLETED` والشحنة موجودة           | ربط حالة الشحنة (`CREATED` = `CONFIRMED`) |
  | الحجز `CANCELLED`، أو الشحنة `CANCELLED`                  | `null` و`attention: 'staff'`              |
  | الشحنة `ON_HOLD` أو `PARTIALLY_DELIVERED` أو حالة بلا ربط | `null` و`attention: 'staff'`              |
  | `rejected` / `cancelled` / `expired`                      | `null` و`attention: null`                 |

  تأكيد الحجز اللي اترجع (الشحنة اتلغت والحجز رجع) بيتبع نفس الجدول من الحالة الحالية، ما من تاريخ قديم.

- **الرد:** `stage: { code, ar, en, order } | null`، `attention: 'staff' | null`، و
  `shipment: { number, stage, city: {ar, en} | null, updatedAt } | null` (الشحنة من حجز الطلب بس، `booking_id ← shipment`).
  `city` ⭐: في `ON_ROAD` و`AT_DESTINATION_HUB` و`DELIVERED` مدينة وجهة الشحنة؛ في الباقي مدينة آخر موقع في سجل الحالات لو
  موجود، وإلا `null`. `updatedAt` = وقت آخر حدث حالة. ما في سعر ولا تكلفة ولا ملاحظات داخلية ولا أسماء موظفين.
- **اختبارات:** موافقة بدون تأكيد = `BOOKED`؛ حجز مسودة اتلغى بعد الموافقة = `attention: 'staff'` ما «مؤكد»؛ كل حالة من
  الـ21 بترجع ربطها أو `attention`؛ تأكيد ثم إلغاء الشحنة ثم رجوع الحجز = من الحالة الحالية؛ تعديل الربط بيغيّر الرد بدون
  كود؛ ما في حقل مالي.

## 4. N-C2 أكتر من صنف في طلب واحد

- **الطلب:** الشكلين بيقبلوا `items: [{ kind|category, quantity, pieces?, lengthCm?, widthCm?, heightCm?, weightKg? }]`
  (1 إلى 10). `quantity` = **كمية التسعير** بوحدة الفئة (عشرية لـ`PER_CBM` و`PER_KG`)، و`pieces` = **عدد الطرود
  الفعلي** (صحيح ≥ 1، اختياري). الشكل القديم (`kind`/`category` + `quantity` في الجذر) مقبول ومعناهو صنف واحد؛ الاتنين
  مع بعض = `400 ITEMS_AND_SINGLE`. طلب بأصناف كلها لنفس الطريق والطريقة (كما اليوم).
- **التخزين:** جدول `cs_booking_request_items` (القسم 10). أعمدة الطلب الحالية بتتملى من **الصنف الأول** عشان القراءات
  القائمة ما تتكسر. الطلبات القديمة بلا أسطر بتتعامل كصنف واحد من أعمدتها (ما في backfill).
- **البصمة:** الشكل القديم بنفس الجسم بيطلع نفس البصمة القديمة (إعادة محاولة بعد النشر = نفس الطلب). شكل `items`
  بيتبصّم بالأسطر بترتيبها.
- **السعر:** `POST /cs/quotes` (نطاق `cs:quote:read`) بجسم `{originId, destinationId, items[], currency?, mode?}`: لكل صنف
  نفس رد `GET /cs/quote` أو خطأ الصنف، و`total` لما كل الأصناف بسعر بنفس العملة (غير كده `null` مع السبب)، و`quoteRef`
  واحد موقّع على كل الأصناف. `GET /cs/quote` ما بيتغيّر.
- **من الصنف لسطر الحجز (F161-3)** عند الموافقة، بدون تخمين:

  | وحدة الفئة                                               | `BookingItem.quantity`                      | الحجم والوزن                                    |
  | -------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------- |
  | `PER_PIECE`، `PER_PALLET`، `PER_BARREL`، `PER_CONTAINER` | كمية التسعير لو صحيحة، أو `pieces` لو موجود | الأبعاد لو موجودة                               |
  | `PER_CBM`                                                | `pieces` بس                                 | `volume_cbm` = كمية التسعير، والأبعاد لو موجودة |
  | `PER_KG`                                                 | `pieces` بس                                 | `weight_kg` = كمية التسعير                      |
  | `PER_SHIPMENT`                                           | `pieces` بس                                 | —                                               |

  صنف ما عندو عدد طرود ثابت (مثلاً 0.25 CBM بدون `pieces`، أو كمية عشرية لوحدة عدّ) **ما بيعمل سطر**: بيظهر في شاشة
  الحجز «أصناف ناقصة العدد» بقيمو المحفوظة، والموظف بيكمّل قبل التأكيد. نوع
  البضاعة لكل سطر من فئتو. رأس الحجز: الطريقة ونوع الحمولة من مدخلات التسعير (واحدة للطلب)؛ `cargo_type` الرأس = نوع
  البضاعة المشترك لو كل الأصناف نفس النوع، وإلا `GENERAL` ⭐؛ أصناف بتحتاج أنواع حمولة مختلفة (حاوية كاملة مع LCL) =
  `422 MIXED_LOAD` والموظف يختار.

- **بوابة اكتمال البضاعة (F161-3، مراجعة 2):** كل صنف طلب ليهو حالة مسجّلة: `cs_booking_request_items.booking_item_id`
  (FK على `booking_items`، `ON DELETE SET NULL`) و`resolved_at`/`resolved_by_id`. الصنف «محلول» لما يكون مربوط بسطر حجز
  موجود. الموافقة بتربط الأصناف اللي عملت سطور. الصنف الناقص بيتحل في شاشة الحجز بس: الموظف بيضيف السطر ويختار الصنف اللي
  بيكمّلو (`POST /bookings/:id/cs-items/:itemId/resolve {bookingItemId, version}`، صلاحية `bookings:update` في فرع الحجز،
  السطر من نفس الحجز، تدقيق). تعديل الحجز اللي بيمسح أو بيبدّل السطور بيرجّع الأصناف المربوطة «غير محلولة» تلقائياً (الـFK
  بيبقى `NULL`)، فالاتجاه دايماً آمن.
  **الفحص على الخادم:** `BookingsService.confirmInTx` (أي طريق تأكيد: الشاشة أو API أو مسودة المساعد) بيقفل أصناف الطلب
  المرتبط بالحجز `FOR UPDATE` في نفس المعاملة، ولو في صنف `booking_item_id IS NULL` = `409 CARGO_INCOMPLETE` بقائمة الأصناف،
  وما في شحنة. حجز ما جاي من طلب بوت ما بيتأثر.

- **الموافقة:** `pricing.items[]` (والقديم صنف واحد)، والبصمة بتغطي كل الأسطر. لقطة السعر لكل سطر في
  `cs_booking_request_items.approved_*`، و`approved_total`/`approved_currency` في الطلب = المجموع.
- **اختبارات:** كرتونتين مجموعهم 0.25 CBM مع برميل معدود = سطرين بالحجم والعدد الصحيح؛ وزن عشري؛ صنف بلا عدد = ما في سطر
  وظاهر للموظف؛ **طلب مختلط (برميل معدود + 0.25 CBM بلا عدد): التأكيد من الشاشة ومن API = `409 CARGO_INCOMPLETE` وما في
  شحنة، وبعد حل الصنف التأكيد بينجح**؛ مسح سطر مربوط بيرجّع الصنف غير محلول ويمنع التأكيد؛ ربط سطر من حجز تاني = مرفوض؛ 11 صنف = 400؛ الشكل القديم = نفس الرد والبصمة؛ صنف بلا سعر = `total: null`؛ بصمة ما بتغطي صنف =
  `PRICE_STALE`؛ `MIXED_LOAD`.

## 5. N-C5 الإشعار (R4 من الخطة 04 القسم 8)

- **تيار واحد لكل طلب (F161-4):** عمود `cs_booking_requests.event_seq` (افتراضي `0`). كل حدث (طلب أو شحنة) بياخد
  `sequence` بـ`UPDATE ... SET event_seq = event_seq + 1 RETURNING event_seq` في **نفس معاملة** القرار أو تغيير الحالة،
  و`unique (request_id, sequence)`. حدثين من نفس التغيير (`shipment.stage_changed` و`shipment.delivered`) بياخدوا رقمين
  متتاليين. `version` الطلب (القفل المتفائل) منفصل وما بيتبعت. الجسم: `{ eventId, type, requestId, sequence,
occurredAt }`. المستقبل بيتجاهل `sequence` أقل من أو يساوي آخر رقم شافو؛ الفجوة عادية (حدث فشل نهائياً) لأن الحدث تنبيه
  والبوت بيقرأ الحقيقة من `GET`.
- **الأحداث:** `request.approved`، `request.rejected`، `request.cancelled`، `request.cancel_requested`،
  `shipment.stage_changed` (المرحلة المحسوبة في القسم 3 اتغيّرت فعلاً)، `shipment.delivered`. بس للطلبات اللي مفتاحها
  عندو عنوان معتمد.
- **العنوان المعتمد:** جدول `cs_webhook_endpoints (api_client_id, url, audience, status, approved_by, ...)` بموافقة شخص غير
  المنشئ (زي تعليمات الدفع). `https` بس، منفذ 443، اسم مضيف (ما IP)، وقائمة مضيفين مسموحين من env
  (`CS_WEBHOOK_ALLOWED_HOSTS`). وقت الإرسال: حلّ DNS ورفض أي عنوان خاص أو داخلي أو loopback أو link-local، والاتصال
  بالعنوان اللي اتحلّ نفسه؛ ما في متابعة تحويل (`redirect: 'error'`)؛ مهلة 10 ثواني وحد للرد.
- **التوقيع:** HMAC-SHA256 بسر من env (`CS_WEBHOOK_SECRET`) على `v1\n<audience>\n<api_client_id>\n<timestamp>\n<body>`؛
  ترويسات `X-Nolon-Timestamp` و`X-Nolon-Key-Id` (المفتاح) و`X-Nolon-Signature`. المستقبل بيتحقق من الجمهور والمفتاح
  والتوقيع و5 دقائق و`eventId`.
- **العامل:** مؤقت داخل الـ API. **الحجز الذري:** `UPDATE cs_outbox SET status='SENDING', lease_until=now()+60s,
attempts=attempts+1 WHERE id IN (SELECT ... WHERE status IN ('PENDING','SENDING') AND (lease_until IS NULL OR
lease_until < now()) AND next_attempt_at <= now() ORDER BY ... FOR UPDATE SKIP LOCKED LIMIT 20) RETURNING ...`، وبعدها
  **الإرسال برا أي معاملة أو قفل عمل**. توقف بعد الإرسال وقبل التسجيل = الحدث بيترسل تاني بعد انتهاء الإيجار (at-least-once،
  والمستقبل بيتجاهل `eventId` المكرر). قبل كل إرسال: المفتاح نشط، عندو النطاق، فرع الطلب لسه من فروعو، والعنوان لسه
  معتمد؛ غير كده `CANCELLED_BY_POLICY` بدون إرسال. `2xx` = `SENT`؛ غيرو إعادة بتأخير متزايد لحد 24 ساعة ثم `FAILED` ظاهر
  للأدمن. فشل الإرسال ما بيلغي القرار.
- **اختبارات:** رول باك القرار = ما في حدث؛ موافقة ثم مرحلة ثم تسليم = تسلسل 1، 2، 3، 4 بدون تكرار؛ وصول خارج الترتيب =
  المستقبل بيرمي الأقدم؛ إيجار منتهي = إعادة إرسال بنفس `eventId`؛ عاملين متزامنين = إرسال واحد للصف؛ عنوان بيتحوّل لـ
  `127.0.0.1` أو `10.x` = مرفوض؛ تحويل 302 = فشل؛ مفتاح مسحوب أو فرع اتشال = ما في إرسال؛ اختبار عقد للتوقيع.

## 6. N-C7 مراجعة شكل المستندات وعقد البوليصة (قبل PDF)

- تقرير `docs/reviews/documents-design-2026-11.md` بلقطات لعرض السعر والحجز والفاتورة (عربي وإنجليزي) مقابل ممارسات: هوية
  وشعار موحد، رقم المرجع وQR بارزين، المبالغ بخط أرقام ثابت ومحاذاة، ترتيب المعلومات من الأهم، تذييل بالشروط وبيانات الفرع،
  A4 وهوامش طباعة. ومعاهو **عقد البوليصة**: الحقول (القسم 7)، القالب، والقناع على الهواتف.
- التقرير بيمر بـ Codex كخطة، وبعدها PR تنفيذ واحد لمكوّنات الطباعة المشتركة، وقالب البوليصة بيتبني على نفس العقد في 09-6.

## 7. N-C4 البوليصة PDF

- **البنية ⭐ (أ):** Gotenberg (Chromium في حاوية منفصلة) على الشبكة الداخلية بس. البديل (ب) Chromium جوه صورة الـ API،
  و(ج) pdfkit (عربي ضعيف). المالك اختار في 2026-10-12 «رابط الطباعة»؛ إرسال ملف للزبون هو الحالة اللي كان متفق نرجع فيها.
  التكلفة تقديرية (~1GB قرص، ~150-250MB ذاكرة أثناء العرض) **وما اتقاست**؛ بتتقاس على staging قبل الإنتاج.
- **العرض الآمن:** القالب في الـ API، وكل نص جاي من مستخدم أو زبون بيتهرّب (escape) قبل HTML. الـ HTML مكتفي بذاتو: الخط
  مضمّن، QR كـ data URI، وما في روابط خارجية؛ Gotenberg بيشتغل بـ `--chromium-deny-list=.*` (ما في جلب خارجي) وعلى
  شبكة داخلية بلا خروج. حدود: عرض واحد لكل مرة بطابور (حد 2 متزامن)، مهلة 20 ثانية، حجم HTML ≤ 512KB وPDF ≤ 5MB.
- **متين تظهر ⭐:** من حالة الشحنة `RECEIVED_ORIGIN_WAREHOUSE` فما بعد (قائمة حالات ثابتة في الكود، **ما من `sort_order`**)،
  والحجز ما ملغي والشحنة ما ملغية. البوت بيرسلها تلقائياً عند التسليم ولما الزبون يطلبها.
- **الرابط والتنزيل:** `documents: { waybill: { url, expiresAt } | null }` في `GET`. الرابط `GET /cs/documents/:token`:
  token عشوائي 32 بايت، محفوظ SHA-256 في `cs_document_links` (فريد)، عمرو 10 دقائق، بنفس مفتاح الـ API في `Authorization`.
  **عند التنزيل** (F161-1 وCodex): المفتاح نشط وعندو النطاق، فرع الطلب من فروعو، صاحب الطلب لسه نفسه (نفس إثبات الإلغاء:
  token الزبون أو توقيع الهوية بنفس الموضوع على طلب التنزيل)، والشحنة لسه مؤهلة؛ غير كده `404`، ومنتهي `410`. كل تنزيل في
  التدقيق. البوليصة بتتعرض للحظة التنزيل (ما في نسخة مخزنة).
- **التسليم للزبون:** تيليجرام ما بيقدر يجيب رابط محمي بـ `nolcs_`. البوت **بينزّل** الملف من خادمو بالمفتاح والتوقيع،
  وبيرفعو لتيليجرام كمستند (`sendDocument` بملف، ما برابط). الرابط ما بيتبعت للزبون ولا للنموذج.
- **المحتوى:** رقم البوليصة (= رقم الشحنة)، التاريخ، المرسل والمستلم (الهاتف مقنّع)، المنشأ والوجهة، الأصناف والعدد والوزن
  والحجم، الخدمات، المرحلة، QR للتتبع العام، شروط ثابتة من الإعدادات. بدون أسعار.
- **اختبارات:** مرسل تاني بنفس المفتاح = 404؛ رابط منتهي = 410؛ مفتاح تاني = 404؛ فرع اتشال بعد إصدار الرابط = 404؛ شحنة
  اتلغت بعد الإصدار = 404؛ تعديل `sort_order` ما بيغيّر الأهلية؛ نص فيهو `<script>` بيطلع نص؛ **اختبار عرض حقيقي** على
  staging (عربي RTL + QR بيتقرا) قبل التفعيل، فوق اختبار الوحدة.

## 8. N-C6 قاعدة العملاء المركزية (ملخص؛ التفصيل في 09b قبل البناء)

- **الهوية (F161-5):** ما في مطابقة جديدة بالهاتف. الأساس هو الملف الموحّد بهوية القناة الموقّعة (الخطة 08 و#155)،
  وتيليجرام بدون هاتف شغال زي ما هو. «الإنشاء الفوري» معناهو: لما طلب البوت يجي **بربط موقّع** (`profileId` +
  `conversationId`) ولفرع معروف، حساب الفرع بيتعمل من الملف في نفس معاملة الحفظ **بنفس فحوص الموافقة اليوم** (قفل الملف،
  `needsReview` بيمنع ويخلي الحالة للموظف، الاسم الناقص بيخلي الحالة للموظف). طلب بدون ربط موقّع أو منتظر توجيه = زي اليوم
  (عند الموافقة). ده **تغيير توقيت** محتاج موافقة المالك الصريحة.
- **الوصول (F161-6):** العميل الموحّد ما بيفتح معاملاتو للكل:
  - **اكتشاف الملف** في كل الفروع (الاسم، رقم الملف، آخر 4 أرقام من الهاتف، الفروع اللي عندو فيها حساب) بصلاحية جديدة
    `customer_profiles:discover`.
  - **قراءة معاملات فرع تاني** (حجوزات، شحنات، فواتير، كشف حساب) بصلاحية صريحة منفصلة لكل مورد، بتتدّى **لشخص بعينو** من
    شاشة الصلاحيات، **بدون بذرة تلقائية لأي دور**، وتحت صلاحية المورد نفسو (ما بتدّي مالية لزول ما عندو مالية)، وبدون
    حقول التكلفة إلا بصلاحيتها، وتحت سقف التفويض وحد الفرع.
  - **المنافذ:** بحث بالاسم أو الهاتف الكامل، نتيجة مختصرة بس (حد 10، تدقيق، حد طلبات). ما في قائمة ولا معاملات.
  - 09b فيها جدول مسار × حقل × صلاحية، واختبارات سالبة لكل واحد.
- **موافقة المالك:** توسيع الوصول بين الفروع وتغيير توقيت الإنشاء قرارين منفصلين، بيتشرحوا للمالك بلغة بسيطة، وما في بناء
  ولا تفعيل قبل موافقتو بكلامو. موافقة الهوية الموحّدة ما بتعني موافقة الوصول.
- **قرار المالك (2026-11-03، بكلامو):** «اختار الافضل لاحقا لو حصلت مشكلة حنرجع نغير» (توقيت الإنشاء: فوري للطلب الموقّع)،
  ثم «الفروع تشوف اي شي لاي عميل، المنافذ هي النعمل عليها قيود». يعني: موظفو كل الفروع بيشوفوا بيانات أي عميل ومعاملاتو
  في كل الفروع، **كل واحد حسب صلاحيات دورو على المورد** (المالية والتكلفة بصلاحيتها كما اليوم)، والقيد على موظف المنفذ بس
  (بحث بنتيجة مختصرة). 09b بتتكتب على القرار ده بدل المنح لكل شخص.

## 9. أثر الوكيل (erp-agents)

- **شرط معروف (F161-7):** `nolon-customer.ts:353` على `f64d7f4` بيرفض `cancelled`. قاعدة «PR التوافق أولاً» **بتنطبق** على
  09-1: PR في erp-agents بيضيف `cancelled` (وقراءة `cancelRequest`، و`409 ALREADY_DECIDED`، و`403 OWNER_PROOF_REQUIRED`) مع
  اختبار عقد للحالة في القراءة وفي رد الإعادة (`replay`)، بيندمج ويتنشر **قبل** ما `CS_BOOKING_CANCEL_ENABLED` يتفتح.
- **النشر والرجوع:** كود نولون ممكن يندمج والمتغير مقفول (ما في طريق لـ`CANCELLED`). الترتيب: مستهلك جديد → فتح المتغير.
  الرجوع: قفل المتغير بيوقف الإلغاءات الجديدة، والطلبات الملغية أصلاً بتفضل `cancelled` (المستهلك الجديد بيفهمها؛ رجوع
  المستهلك لنسخة قديمة بعد وجود طلبات ملغية = خطأ `unavailable` لتلك الطلبات بس، فما بنرجّع المستهلك قبل نولون).
- **حقول جديدة** (`stage`، `attention`، `shipment`، `documents`، `cancelRequest`): الكائن عند المستهلك ما `strict`، فبتتجاهل
  لحدي ما البوت يستعملها. اختبار عقد في erp-agents بيثبت ده قبل 09-2.
- مسارات الموظف `@AgentReadable` ومسودات المساعد الـ12 ما بتتغيّر.
- بعد كل PR بيندمج: ملاحظة قصيرة لمشروع المساعد بالعقد والأخطاء الجديدة.

## 11. N-C8 مكان التسليم في رد الموافقة

- **وين بيتسجّل المكان:** نقاط التسليم هي **المرافق** في جدول `warehouses` الموجود (مراكز التجميع والتوزيع والتسليم ونوافذ
  الاستلام)، ما جدول جديد. خيط «إضافة مراكز ومنافذ تجريبية بمواقعها» بيضيف للجدول ده نوع المرفق والتلفون والإحداثيات
  وبيبذر المرافق التجريبية؛ 09-8 بيبني فوق أعمدتو وما بيكررها. 09-8 بيضيف بس:
  - `address_en` (العمود الحالي `address` بيبقى العنوان العربي)،
  - `accepts_drop_off` (افتراضي `false`): المرفق بيستلم شحنات من الزبائن،
  - `partner_id` اختياري (FK على `partners`، شريك `SALES_OUTLET`) لنافذة استلام بتتبع منفذ،
  - `map_url` اختياري (https بس، حد 500). لو فاضي والإحداثيات موجودة، الرابط بيتحسب
    `https://www.google.com/maps?q=<lat>,<lng>`.
    التعديل من شاشة المخازن الحالية بصلاحية `warehouses:update` (أو `master_data:update` حسب الموجود)، مع تدقيق.
- **الطلب:** عمود `cs_booking_requests.drop_off_warehouse_id`. عند الموافقة الموظف بيختار `dropOffId` (اختياري في جسم
  الموافقة). لو ما اختار: لو فرع الطلب عندو نقطة تسليم نشطة واحدة بس، هي الافتراضية؛ غير كده بيفضل فاضي و`dropOff: null`.
  النقطة لازم تكون نشطة، و`accepts_drop_off`، وفي فرع الموظف عندو فيهو `cs_booking_requests:approve` (عادة فرع الطلب). غير
  كده `400 DROP_OFF_NOT_ALLOWED`. مسار تصحيح بعد الموافقة: `POST /cs-booking-requests/:id/drop-off {version, dropOffId}`
  بنفس الفحص وتدقيق.
- **القراءة:** `GET /cs/booking-requests/:id` بيرجّع `dropOff: { name{ar,en}, address{ar,en}|null, phone|null, mapUrl|null }`
  لما الحالة `approved` بس، وغيرها `null`. ⭐ **البيانات الحالية للنقطة** (ما لقطة لحظة الموافقة): لو الفرع صحّح تلفون أو
  عنوان، الزبون بيشوف الصحيح. `address` بيرجع `null` لو العربي والإنجليزي الاتنين فاضيين؛ لو واحد بس موجود بيتكرر في
  التاني. نقطة اتوقفت بعد الموافقة بترجع `dropOff: null`.
- **اختبارات القبول الخمسة:** نقطة كاملة = الأربعة؛ `pending`/`rejected` = `null`؛ بلا خريطة ولا إحداثيات = `mapUrl: null`
  والباقي يرجع؛ نقطة فرع تاني بدون صلاحية = `400`؛ تعديل النقطة بعد الموافقة = القراءة بالبيانات الجديدة. وزيادة: نقطة
  ما `accepts_drop_off` مرفوضة؛ الاختيار الافتراضي لما في نقطة واحدة؛ `mapUrl` غير https مرفوض في الحفظ.

## 12. N-C9 الأغراض الما معيارية: صور وتقدير الموظف

- **الصنف `OTHER` (يدخل مع 09-3):** في `items[]` بالشكلين: `{ kind: "OTHER", description, pieces?, lengthCm?, widthCm?,
heightCm?, weightKg? }`. `description` إجباري (حد 500)، وما في `quantity` ولا فئة سعر. السطر بيتحفظ في
  `cs_booking_request_items` بـ`is_other = true` و`description`، و`price_category_code` فاضي. ⭐ طلب فيهو صنف `OTHER`
  **ما بيتوافق عليهو مباشرة**: الموظف لازم يقدّر أولاً (`409 ESTIMATE_REQUIRED` في الموافقة). السعر من البوت لصنف `OTHER`
  مرفوض (`400`).
- **رفع الصور:** `POST /cs/booking-requests/:id/photos`، **جسم ثنائي خام** (صورة واحدة لكل نداء) مع `Idempotency-Key`.
  الجسم الخام بيدخل في توقيع الهوية (sha256 للجسم، الخطة 08)، فما في multipart.
  - إثبات صاحب الطلب زي الإلغاء (القسم 2): token الزبون، أو هوية القناة الموقّعة لموضوع المرسل. المفتاح براهو = `403`.
  - النوع من **محتوى الملف** (JPEG/PNG/WebP بالبايتات الأولى) ما من الترويسة؛ غيرها `415 UNSUPPORTED_IMAGE`.
  - حد 10MB للصورة (حد الجسم في المسار ده بس) و10 صور للطلب (`409 PHOTO_LIMIT`، العدّ تحت قفل صف الطلب).
  - مسموح والطلب `pending` أو `awaiting_routing` أو `estimated`.
  - نفس المفتاح ونفس الملف = نفس الرد؛ نفس المفتاح بملف تاني = `409`.
  - التخزين في جدول `cs_booking_request_photos` (المحتوى `bytea` في الجدول، زي `document_contents`)، مع sha256 والحجم
    والنوع.
  - الموظف بيشوف الصور في شاشة الطلب عبر `GET /cs-booking-requests/:id/photos/:photoId` بصلاحية العرض في فرع الطلب، مع
    `Content-Disposition: inline` ونوع المحتوى المحفوظ و`X-Content-Type-Options: nosniff`.
- **تقدير الموظف:** `POST /cs-booking-requests/:id/estimate {version, amount, currency, noteAr?, noteEn?, validUntil}`.
  - صلاحية `cs_booking_requests:approve` في فرع الطلب، والطلب `pending` بفرع.
  - المبلغ `Decimal` أكبر من صفر، والعملة نشطة من جدول العملات.
  - ⭐ `validUntil` بعد الآن وفي حدود 14 يوم، و`expires_at` الطلب بيتمد لحدها لو أقصر.
  - الطلب بيبقى `ESTIMATED` (قيمة enum جديدة)، مع تدقيق، و`estimate_version` بيزيد واحد مع كل تقدير. تقدير جديد على طلب
    `estimated` بيبدّل القديم (نسخة الطلب بتمنع السباق).
  - (Codex F165-2) أي تقدير جديد، حتى على طلب رجع `pending` بعد قبول، بيمسح `estimate_accepted_at` و
    `estimate_accepted_version` في نفس المعاملة ويرجّع الطلب `estimated`: القبول القديم ما بيغطي سعر جديد.
- **القراءة:** `status: "estimated"` و`estimate: { version, amount, currency, note{ar,en}, validUntil }` في `estimated` بس،
  وغيرها `null`. (Codex F165-1) `version` = `estimate_version`، وهو الرقم البيرسلو البوت في القبول. بعد `validUntil` القراءة بتقول `expired`، والطلب بيطلع من قائمة المراجعة المفتوحة.
- **قبول الزبون:** `POST /cs/booking-requests/:id/accept-estimate {estimateVersion}` بإثبات صاحب الطلب.
  - قبل `validUntil` ولنفس التقدير المعروض (`estimateVersion` = `estimate_version` الحالي)، الطلب بيرجع `pending` مع
    `estimate_accepted_at` و`estimate_accepted_version` = النسخة المقبولة، في معاملة واحدة بقفل الصف.
  - بعد `validUntil` = `409 ESTIMATE_EXPIRED`. تقدير اتبدّل = `409 ESTIMATE_CHANGED`. التكرار = نفس الرد.
  - ⭐ **الرفض** = الإلغاء الموجود (القسم 2)، بقى مسموح كمان في `estimated`.
- **الموافقة بعد القبول:** (Codex F165-2) الموافقة على طلب فيهو `OTHER` بتشترط `estimate_accepted_version` =
  `estimate_version` الحالي و`validUntil` لسه ما فات، وغير كده `409 ESTIMATE_REQUIRED`. الموظف بيوافق، و
  `approved_total`/`approved_currency` = مبلغ وعملة النسخة المقبولة نفسها، بدون بصمة سعر المحرّك
  (السعر اتفق عليهو). سطور `OTHER` بتعمل سطر حجز `GENERAL` لو `pieces` موجود، وغير كده بتمسك بوابة اكتمال البضاعة (القسم 4).
- **التوافق (زي الإلغاء):** المستهلك الحالي بيرفض حالة ما يعرفها، فـ`estimated` مقفولة بمتغير `CS_ESTIMATES_ENABLED`
  (افتراضي `false`): مقفول = مسار التقدير `503`، ورفع الصور شغال. الترتيب: PR مستهلك في erp-agents بيقبل `estimated`
  و`estimate` وأخطاء القبول، بعدين فتح المتغير.
- **اختبارات القبول:** رفع من غير صاحب الطلب = 404 أو 403؛ ملف مش صورة (PDF بامتداد jpg) = 415؛ الصورة 11 = 409؛ نفس
  المفتاح ونفس الصورة = نفس الرد؛ تقدير من موظف بدون صلاحية في الفرع = 403؛ `estimate` بيظهر في `estimated` بس؛ قبول بعد
  `validUntil` = 409؛ موافقة طلب فيهو `OTHER` بدون تقدير = 409؛ متغير مقفول = 503؛ القراءة فيها `estimate.version` والقبول
  بيها ينجح؛ تقدير جديد بعد القبول بيمسح القبول ويرجّع `estimated`، والموافقة قبل قبول النسخة الجديدة = 409؛ القبول بنسخة
  قديمة = `409 ESTIMATE_CHANGED`؛ قبول v1 ثم تقدير v2 ثم موافقة من غير قبول v2 = 409؛ قبول وتقدير جديد في نفس اللحظة
  (الاتنين بيقفلوا صف الطلب) = واحد بس ينجح، والنتيجة يا قبول لـv2 يا v2 بدون قبول، أبداً قبول v1 مع مبلغ v2.
- **الحدث (09-4):** `request.estimated` في نفس التيار.

## 10. البيانات (SQL المقترح؛ الموافقة النهائية في PR كل بند)

```sql
-- 09-1
ALTER TYPE "cs_booking_request_status" ADD VALUE 'CANCELLED';
ALTER TABLE "cs_booking_requests"
  ADD COLUMN "cancelled_at" TIMESTAMPTZ(3), ADD COLUMN "cancel_reason" VARCHAR(300),
  ADD COLUMN "cancel_requested_at" TIMESTAMPTZ(3), ADD COLUMN "cancel_request_reason" VARCHAR(300),
  ADD COLUMN "cancel_request_closed_at" TIMESTAMPTZ(3), ADD COLUMN "cancel_request_closed_by_id" UUID;
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_cancel_request_closed_by_id_fkey"
  FOREIGN KEY ("cancel_request_closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- التدقيق: الكيان 'CS_BOOKING_REQUEST' نص في audit_events.entity (VARCHAR)، والإجراءات الحالية CANCELLED/UPDATED.

-- 09-2
CREATE TABLE "customer_stages" ("code" VARCHAR(30) PRIMARY KEY, "name_ar" VARCHAR(100) NOT NULL,
  "name_en" VARCHAR(100) NOT NULL, "sort_order" SMALLINT NOT NULL, "is_active" BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE "shipment_status_stages" ("status" "shipment_status" PRIMARY KEY,
  "stage_code" VARCHAR(30) NOT NULL REFERENCES "customer_stages"("code") ON DELETE RESTRICT);
-- بذرة: 9 مراحل و18 ربط (INSERT في نفس الـ migration، جداول جديدة).

-- 09-3
CREATE TABLE "cs_booking_request_items" ("id" UUID PRIMARY KEY, "request_id" UUID NOT NULL
  REFERENCES "cs_booking_requests"("id") ON DELETE RESTRICT, "line_no" SMALLINT NOT NULL CHECK ("line_no" BETWEEN 1 AND 10),
  "price_category_code" VARCHAR(20) REFERENCES "price_categories"("code") ON DELETE RESTRICT, "bot_kind" JSONB,
  "quantity" DECIMAL(18,4) NOT NULL CHECK ("quantity" > 0), "pieces" INTEGER CHECK ("pieces" >= 1),
  "length_cm" DECIMAL(10,2), "width_cm" DECIMAL(10,2), "height_cm" DECIMAL(10,2), "weight_kg" DECIMAL(12,3),
  "approved_category_code" VARCHAR(20) REFERENCES "price_categories"("code") ON DELETE RESTRICT,
  "approved_quantity" DECIMAL(18,4), "approved_total" DECIMAL(18,4),
  "booking_item_id" UUID REFERENCES "booking_items"("id") ON DELETE SET NULL,
  "resolved_at" TIMESTAMPTZ(3), "resolved_by_id" UUID REFERENCES "users"("id") ON DELETE RESTRICT,
  UNIQUE ("request_id", "line_no"));
CREATE UNIQUE INDEX ON "cs_booking_request_items" ("booking_item_id");

-- 09-4
ALTER TABLE "cs_booking_requests" ADD COLUMN "event_seq" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "cs_webhook_endpoints" ("id" UUID PRIMARY KEY, "api_client_id" UUID NOT NULL REFERENCES "api_clients"("id"),
  "url" VARCHAR(500) NOT NULL, "audience" VARCHAR(100) NOT NULL, "status" VARCHAR(10) NOT NULL,
  "created_by_id" UUID NOT NULL REFERENCES "users"("id"), "approved_by_id" UUID REFERENCES "users"("id"),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "approved_at" TIMESTAMPTZ(3), "retired_at" TIMESTAMPTZ(3),
  CHECK ("approved_by_id" IS NULL OR "approved_by_id" <> "created_by_id"));
CREATE UNIQUE INDEX ON "cs_webhook_endpoints" ((CASE WHEN "status" = 'APPROVED' THEN "api_client_id" END));
CREATE TABLE "cs_outbox" ("id" UUID PRIMARY KEY, "api_client_id" UUID NOT NULL REFERENCES "api_clients"("id"),
  "request_id" UUID NOT NULL REFERENCES "cs_booking_requests"("id"), "sequence" INTEGER NOT NULL,
  "type" VARCHAR(40) NOT NULL, "occurred_at" TIMESTAMPTZ(3) NOT NULL, "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0, "next_attempt_at" TIMESTAMPTZ(3) NOT NULL, "lease_until" TIMESTAMPTZ(3),
  "sent_at" TIMESTAMPTZ(3), "last_error" VARCHAR(300), UNIQUE ("request_id", "sequence"));
CREATE INDEX ON "cs_outbox" ("status", "next_attempt_at");

-- 09-6
CREATE TABLE "cs_document_links" ("id" UUID PRIMARY KEY, "token_hash" CHAR(64) NOT NULL UNIQUE,
  "api_client_id" UUID NOT NULL REFERENCES "api_clients"("id"), "request_id" UUID NOT NULL
  REFERENCES "cs_booking_requests"("id"), "kind" VARCHAR(20) NOT NULL, "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "expires_at" TIMESTAMPTZ(3) NOT NULL, "used_count" INTEGER NOT NULL DEFAULT 0, CHECK ("expires_at" > "created_at"));
CREATE INDEX ON "cs_document_links" ("expires_at");

-- 09-8 (بعد أعمدة خيط المرافق التجريبية: النوع والتلفون والإحداثيات)
ALTER TABLE "warehouses" ADD COLUMN "address_en" VARCHAR(500),
  ADD COLUMN "accepts_drop_off" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "partner_id" UUID, ADD COLUMN "map_url" VARCHAR(500);
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_partner_id_fkey"
  FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cs_booking_requests" ADD COLUMN "drop_off_warehouse_id" UUID;
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_drop_off_warehouse_id_fkey"
  FOREIGN KEY ("drop_off_warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- فحص https لـ map_url في الخدمة (CHECK على جدول قائم ما إضافي).

-- 09-3 (إضافة لصنف OTHER في الجدول الجديد)
--   "is_other" BOOLEAN NOT NULL DEFAULT false, "description" VARCHAR(500),
--   CHECK (("is_other" AND "description" IS NOT NULL AND "price_category_code" IS NULL) OR NOT "is_other")
--   و"quantity" بيبقى nullable لصنف OTHER (بدل NOT NULL فوق). (Codex F165-3) الصنف العادي لازم كميتو موجودة وموجبة،
--   لأنو CHECK ("is_other" OR "quantity" > 0) بيعدّي NULL:
--   CHECK (("is_other" AND "quantity" IS NULL) OR (NOT "is_other" AND "quantity" IS NOT NULL AND "quantity" > 0))

-- 09-9
ALTER TYPE "cs_booking_request_status" ADD VALUE 'ESTIMATED';
ALTER TABLE "cs_booking_requests" ADD COLUMN "estimate_amount" DECIMAL(18,4),
  ADD COLUMN "estimate_currency" CHAR(3), ADD COLUMN "estimate_note_ar" VARCHAR(500),
  ADD COLUMN "estimate_note_en" VARCHAR(500), ADD COLUMN "estimate_valid_until" TIMESTAMPTZ(3),
  ADD COLUMN "estimate_version" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "estimated_by_id" UUID,
  ADD COLUMN "estimated_at" TIMESTAMPTZ(3), ADD COLUMN "estimate_accepted_at" TIMESTAMPTZ(3),
  ADD COLUMN "estimate_accepted_version" INTEGER;
-- (Codex F165-2) القبول مربوط بنسخة: الاتنين مع بعض أو فاضيين، والنسخة المقبولة ما بتتعدى الحالية. الشرط في الخدمة
-- وفي الاختبارات (CHECK على جدول قائم ما إضافي، زي map_url فوق)؛ لو المالك وافق على هجرة غير إضافية، بيبقى:
--   CHECK (("estimate_accepted_at" IS NULL AND "estimate_accepted_version" IS NULL) OR
--     ("estimate_accepted_at" IS NOT NULL AND "estimate_accepted_version" IS NOT NULL
--       AND "estimate_accepted_version" BETWEEN 1 AND "estimate_version"))
--   (Codex F165-4) اختبار الحالتين النص فاضية: وقت بدون نسخة، ونسخة بدون وقت، الاتنين مرفوضين.
-- FKs: estimate_currency → currencies(code)، estimated_by_id → users(id)، ON DELETE RESTRICT.
CREATE TABLE "cs_booking_request_photos" ("id" UUID PRIMARY KEY, "request_id" UUID NOT NULL
  REFERENCES "cs_booking_requests"("id") ON DELETE RESTRICT, "idempotency_key" VARCHAR(100) NOT NULL,
  "content_type" VARCHAR(20) NOT NULL CHECK ("content_type" IN ('image/jpeg', 'image/png', 'image/webp')),
  "size_bytes" INTEGER NOT NULL CHECK ("size_bytes" BETWEEN 1 AND 10485760), "sha256" CHAR(64) NOT NULL,
  "content" BYTEA NOT NULL, "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE ("request_id", "idempotency_key"));
```

ما في جدول محاسبي، وما في تعديل لصف قائم. البذور في جداول جديدة. الصلاحيات الجديدة (N-C6) في الكود، وبتغيّر الوصول حتى لو
SQL إضافي، فموافقتها منفصلة (القسم 8).

## 13. تعديل 4 (2026-11-03): ما اتغيّر أثناء بناء 09-3، وطلبات المساعد للمستندات

**في 09-3 (مبني في نفس الـPR):**

- **ربط الصنف الناقص** على مسار الطلب: `POST /cs-booking-requests/:id/items/:itemId/resolve {bookingItemId}` بصلاحية
  `bookings:update` في فرع الطلب، بدل مسار `/bookings` في القسم 4. السبب: وحدة الحجوزات ما بتقرا جداول خدمة العملاء
  (modular monolith). الفحوص نفسها: الحجز مسودة ومقفول، الصنف للطلب وما مربوط، السطر من نفس الحجز وما مربوط بصنف تاني،
  وتدقيق. بوابة التأكيد (`CARGO_INCOMPLETE`) بتتسجّل من خدمة العملاء في `BookingConfirmChecksRegistry` وبتشتغل جوه
  `confirmInTx` لكل طرق التأكيد.
- **جسم الموافقة:** طلب بأصناف بيرسل `pricing` (الطريق والطريقة والعملة) و`lines: [{category, quantity,
pricingFingerprint}]` سطر لكل صنف بالترتيب، وبدون `category`/`quantity`/`pricingFingerprint` في الجذر. الشكل القديم
  ما اتغيّر. الأخطاء: `400 LINES_REQUIRED`، `400 LINES_MISMATCH`، `409 ESTIMATE_REQUIRED` (صنف `OTHER` لحدي 09-9)،
  `422 MIXED_LOAD`، و`PRICE_STALE` لأي سطر.
- **`POST /cs/quotes`:** كل صنف بـ`quoteRef` خاص بيهو (زي `GET /cs/quote`) بدل مرجع واحد موقّع على الكل، عشان كل صنف في
  الطلب بيحمل مرجعو. الرد `{ items: [{quote, error}], total, currency, totalReason }`.
- **قراءة البوت (طلب المساعد):** `approvedPrice: {amount, currency} | null` بعد الموافقة بس (المجموع المعتمد بعملة
  التسعير)، و`shipment.trackingUrl` (رابط التتبع العام اللي الـQR بيفتحو)، و`validUntil` في رد السعر (نفس
  `quoteRefExpiresAt`).

- **(Codex F167-1) الحجز بيمشي على المعتمد:** سطر الحجز من فئة وكمية الموظف المعتمدة (نفس اللي اتسعّرت)، ما من رقم
  الزبون الأول: العدد للوحدات المعدودة، والحجم لـCBM، والوزن للكيلو. الطرود والأبعاد والوزن اللي قالها الزبون بتفضل زي ما هي.
  لو الـCBM المعتمد بيخالف حجم أبعاد الطرود (الحجز بيحسب الحجم من الأبعاد)، أو الكيلو المعتمد بيخالف وزن الزبون، ما
  بيتعمل سطر تلقائي: الصنف بيفضل مفتوح بقياسات الزبون، والطلب بيحتفظ بالكمية المعتمدة وسعرها، والموظف بيضيف السطر
  بالقياسات الصحيحة ويربطو قبل التأكيد. ما بنمسح أي واحد منهم.
- **(Codex F167-2) الأبعاد التلاتة مع بعض:** صنف فيهو بُعد أو بُعدين بس بيترفض عند الاستلام بالشكلين
  `400 { code: "DIMENSIONS_TOGETHER", fields: ["items.N.widthCm", ...] }` عشان البوت يسأل عن الناقص. ما في تخمين.

**على بنود لاحقة (بدون تغيير على العقد الموجود):**

- **09-8:** `dropOff.hours {ar, en} | null` (مواعيد عمل النقطة)، وهاتف خدمة العملاء لكل فرع من الإعدادات في الكتالوج.
- **09-5:** هوية المستندات المشتركة من طلب المساعد: الخط IBM Plex Sans Arabic (OFL)، الأزرق `#14467f`، البرتقالي
  `#e8871e`، الأخضر `#1d7a46`، النص `#16212c`/`#5b6875`، الحدود `#dde4ea`، الخلفيات `#eaf1f8`/`#f4f6f8`/`#fdf3e7`؛
  الأرقام والهواتف من الشمال لليمين؛ المبلغ المهم في صندوق أزرق؛ ملاحظة الدفع في صندوق برتقالي فاتح. بتتطبق على
  `PrintKit`.
- **09-6:** القالب على اسكتش المساعد (`/mnt/project-files/nolon/agent-documents/sketch-waybill-for-nolon.png`)، وزيادة:
  وصف محتوى الطرود، باركود رقم الشحنة جنب الـQR، تاريخ التسليم والمستلم الفعلي لو اتسجّلوا، خانات توقيع، عنوان نولون
  وهاتفها في الذيل. بعد الدمج على staging ملاحظة للمساعد: متين الرابط بيظهر، اسم الملف ونوعو، وهل التنزيل محتاج ترويسات
  الهوية.
- ⭐ **آخر موعد لتسليم الشحنة قبل الرحلة:** مؤجل؛ نولون ما عندها جدول رحلات يطلع منو تاريخ.

## 14. تعديل 5 (2026-11-03): ما اتغيّر أثناء بناء 09-8

- **النقطة من فرع الطلب بس:** الموظف بيسمّي نقطة نشطة بتستقبل الشحنات من نفس فرع الطلب، حتى لو عندو صلاحية الموافقة في
  فرع تاني؛ غير كده `400 DROP_OFF_NOT_ALLOWED`. الخيارات في شاشة الموظف (`dropOffChoices`) من فرع الطلب بس، والنقطة
  المسمّاة بتظهر للموظف في `dropOffPoint` حتى لو اتقفلت بعدين (البوت بيقراها `null`).
- **بيانات النقطة في المخزن نفسو:** `warehouses` زادت `accepts_drop_off` و`address_en` و`hours_ar`/`hours_en`
  و`map_url` (https بس) و`partner_id` (منفذ بيع نشط من نفس الفرع). التعديل من شاشة المخازن بصلاحية `warehouse:update`،
  وكل تغيير في السجل (`WAREHOUSE`).
- **هاتف خدمة العملاء لكل فرع:** `branches.support_phone` (E.164)، بيتعدّل من شاشة طلبات البوت بصلاحية
  `master_data:update` (`PUT /master-data/branches/:id/support-phone`، في السجل `BRANCH`)، والكتالوج بيرجّع
  `support: [{branchId, code, nameAr, nameEn, phone}]` لفروع المفتاح اللي ليها رقم بس.
- **البذرة التجريبية:** مراكز التجميع ونوافذ الاستلام في مدن المنشأ (مش نوافذ السودان ولا مراكز التسليم ولا سواكن) بتبقى
  نقاط تسليم بمواعيد تجريبية، مرة واحدة: المرفق اللي ليهو مواعيد أو موقوف أو معلَّم من قبل بيتخلّى زي ما هو.
