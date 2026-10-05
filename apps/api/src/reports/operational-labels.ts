import type { Locale } from '@nolon/shared';

/**
 * Captions of the operational report exports (annex D section 3), in the request's language. The
 * status names are the ones the web app shows (messages Enums).
 */
const LABELS = {
  // Titles
  shipmentsReport: {
    en: 'Shipments by status, branch, route and mode',
    ar: 'الشحنات حسب الحالة والفرع والمسار ونمط الشحن',
  },
  lateShipments: {
    en: 'Shipments late against ETA',
    ar: 'الشحنات المتأخرة عن موعد الوصول المتوقع',
  },
  salesConversion: {
    en: 'Quotations, bookings and conversion',
    ar: 'عروض الأسعار والحجوزات ونسبة التحويل',
  },
  customerActivity: { en: 'Customer activity', ar: 'نشاط العملاء' },
  warehouseOnHand: { en: 'Warehouse goods on hand', ar: 'البضاعة الموجودة في المستودعات' },
  warehouseMovements: {
    en: 'Warehouse receipts and releases',
    ar: 'حركات الاستلام والإخراج في المستودعات',
  },
  customsFiles: { en: 'Customs files and clearance time', ar: 'الملفات الجمركية ومدة التخليص' },
  tripsReport: {
    en: 'Trips by vehicle, driver and carrier',
    ar: 'الرحلات حسب المركبة والسائق والناقل',
  },
  auditLog: { en: 'Audit log', ar: 'سجل التدقيق' },
  // Filters and notes
  period: { en: 'Period', ar: 'الفترة' },
  etaPeriod: { en: 'ETA between', ar: 'موعد الوصول المتوقع بين' },
  asOf: { en: 'As of', ar: 'حتى تاريخ' },
  branch: { en: 'Branch', ar: 'الفرع' },
  allBranches: { en: 'All my branches', ar: 'كل فروعي' },
  truncated: {
    en: 'Only the first rows are listed; narrow the filters to see all.',
    ar: 'تُعرض الصفوف الأولى فقط؛ ضيّق الفلاتر لرؤية الكل.',
  },
  costNote: {
    en: 'Cost in USD: posted trip expenses and accruals, less cancellations.',
    ar: 'التكلفة بالدولار: مصروفات الرحلات والاستحقاقات المرحّلة بعد خصم الإلغاءات.',
  },
  revenueNote: {
    en: 'Revenue in USD: approved invoices dated in the period.',
    ar: 'الإيراد بالدولار: الفواتير المعتمدة المؤرخة في الفترة.',
  },
  changes: { en: 'Changes', ar: 'التغييرات' },
  source: { en: 'Source', ar: 'المصدر' },
  auditNote: {
    en: 'Rates, customers and user accounts: field by field from the append-only audit table. The rest from the records that keep who did what: shipment events, warehouse, customs, journal entries, invoices, receipts, credit notes, supplier bills and payments, expenses, trips, PODs and documents. Times in UTC.',
    ar: 'الأسعار والعملاء وحسابات المستخدمين: حقلاً بحقل من جدول التدقيق الذي لا يُعدَّل. والباقي من السجلات التي تحفظ من فعل ماذا: أحداث الشحنات والمستودع والجمارك والقيود والفواتير والمقبوضات والإشعارات الدائنة وفواتير الموردين ومدفوعاتهم والمصروفات والرحلات وإثباتات التسليم والمستندات. الأوقات بالتوقيت العالمي.',
  },
  // Sheets and sections
  summary: { en: 'Summary', ar: 'الملخص' },
  shipments: { en: 'Shipments', ar: 'الشحنات' },
  byStatus: { en: 'By status', ar: 'حسب الحالة' },
  byBranch: { en: 'By branch', ar: 'حسب الفرع' },
  byRoute: { en: 'By route', ar: 'حسب المسار' },
  byMode: { en: 'By mode', ar: 'حسب نمط الشحن' },
  byVehicle: { en: 'By vehicle', ar: 'حسب المركبة' },
  byDriver: { en: 'By driver', ar: 'حسب السائق' },
  byCarrier: { en: 'By carrier', ar: 'حسب الناقل' },
  files: { en: 'Files', ar: 'الملفات' },
  movements: { en: 'Movements', ar: 'الحركات' },
  trips: { en: 'Trips', ar: 'الرحلات' },
  entries: { en: 'Entries', ar: 'السجلات' },
  // Columns
  group: { en: 'Group', ar: 'المجموعة' },
  value: { en: 'Value', ar: 'القيمة' },
  count: { en: 'Count', ar: 'العدد' },
  total: { en: 'Total', ar: 'الإجمالي' },
  number: { en: 'Number', ar: 'الرقم' },
  customer: { en: 'Customer', ar: 'العميل' },
  origin: { en: 'Origin', ar: 'المنشأ' },
  destination: { en: 'Destination', ar: 'الوجهة' },
  mode: { en: 'Mode', ar: 'نمط الشحن' },
  status: { en: 'Status', ar: 'الحالة' },
  createdOn: { en: 'Created on', ar: 'تاريخ الإنشاء' },
  etd: { en: 'ETD', ar: 'موعد المغادرة المتوقع' },
  eta: { en: 'ETA', ar: 'موعد الوصول المتوقع' },
  deliveredOn: { en: 'Delivered on', ar: 'تاريخ التسليم' },
  daysLate: { en: 'Days late', ar: 'أيام التأخير' },
  withEta: { en: 'Shipments with an ETA in the period', ar: 'شحنات موعد وصولها في الفترة' },
  late: { en: 'Late', ar: 'متأخرة' },
  openLate: { en: 'Late, not delivered', ar: 'متأخرة ولم تُسلَّم' },
  deliveredLate: { en: 'Delivered late', ar: 'سُلّمت متأخرة' },
  averageDaysLate: { en: 'Average days late', ar: 'متوسط أيام التأخير' },
  quotationsSent: { en: 'Quotations sent', ar: 'عروض مرسلة' },
  quotationsOpen: { en: 'Awaiting answer', ar: 'بانتظار الرد' },
  quotationsApproved: { en: 'Approved', ar: 'معتمدة' },
  quotationsRejected: { en: 'Rejected', ar: 'مرفوضة' },
  quotationsExpired: { en: 'Expired', ar: 'منتهية' },
  quotationsBooked: { en: 'Booked', ar: 'تحولت إلى حجز' },
  approvalRate: { en: 'Approval rate %', ar: 'نسبة الاعتماد %' },
  conversionRate: { en: 'Conversion rate %', ar: 'نسبة التحويل %' },
  bookingsCreated: { en: 'Bookings created', ar: 'حجوزات منشأة' },
  bookingsDraft: { en: 'Draft', ar: 'مسودة' },
  bookingsConfirmed: { en: 'Confirmed', ar: 'مؤكدة' },
  bookingsCompleted: { en: 'Completed', ar: 'مكتملة' },
  bookingsCancelled: { en: 'Cancelled', ar: 'ملغاة' },
  bookingsFromQuotation: { en: 'From a quotation', ar: 'من عرض سعر' },
  confirmationRate: { en: 'Confirmation rate %', ar: 'نسبة التأكيد %' },
  shipmentCount: { en: 'Shipments', ar: 'عدد الشحنات' },
  volumeCbm: { en: 'Volume (CBM)', ar: 'الحجم (م³)' },
  weightKg: { en: 'Weight (kg)', ar: 'الوزن (كغ)' },
  invoices: { en: 'Invoices', ar: 'الفواتير' },
  revenueUsd: { en: 'Revenue (USD)', ar: 'الإيراد (دولار)' },
  shipment: { en: 'Shipment', ar: 'الشحنة' },
  warehouse: { en: 'Warehouse', ar: 'المستودع' },
  packages: { en: 'Packages', ar: 'عدد الطرود' },
  heldSince: { en: 'Held since', ar: 'محفوظة منذ' },
  daysHeld: { en: 'Days held', ar: 'مدة البقاء (أيام)' },
  kind: { en: 'Kind', ar: 'النوع' },
  occurredAt: { en: 'Date and time', ar: 'التاريخ والوقت' },
  condition: { en: 'Condition', ar: 'الحالة' },
  party: { en: 'Delivered or collected by', ar: 'المُسلِّم أو المستلِم' },
  recordedBy: { en: 'Recorded by', ar: 'سجّلها' },
  receipts: { en: 'Receipts', ar: 'الاستلامات' },
  releases: { en: 'Releases', ar: 'الإخراجات' },
  declaration: { en: 'Declaration', ar: 'رقم البيان' },
  broker: { en: 'Broker', ar: 'المخلّص' },
  openedOn: { en: 'Opened on', ar: 'تاريخ الفتح' },
  submittedOn: { en: 'Submitted on', ar: 'تاريخ التقديم' },
  clearedOn: { en: 'Cleared on', ar: 'تاريخ التخليص' },
  clearanceDays: { en: 'Clearance days', ar: 'مدة التخليص (أيام)' },
  daysOpen: { en: 'Days open', ar: 'أيام مفتوحة' },
  averageClearanceDays: { en: 'Average clearance days', ar: 'متوسط مدة التخليص (أيام)' },
  tripDate: { en: 'Trip date', ar: 'تاريخ الرحلة' },
  vehicle: { en: 'Vehicle', ar: 'المركبة' },
  driver: { en: 'Driver', ar: 'السائق' },
  carrier: { en: 'Carrier', ar: 'الناقل' },
  tripCount: { en: 'Trips', ar: 'عدد الرحلات' },
  costUsd: { en: 'Cost (USD)', ar: 'التكلفة (دولار)' },
  name: { en: 'Name', ar: 'الاسم' },
  at: { en: 'When (UTC)', ar: 'الوقت (UTC)' },
  user: { en: 'User', ar: 'المستخدم' },
  entity: { en: 'Record', ar: 'السجل' },
  action: { en: 'Action', ar: 'الإجراء' },
  reference: { en: 'Reference', ar: 'المرجع' },
  detail: { en: 'Detail', ar: 'التفاصيل' },
  system: { en: 'Not recorded', ar: 'غير مسجّل' },
} as const satisfies Record<string, Record<Locale, string>>;

const SHIPMENT_STATUS = {
  CREATED: { en: 'Created', ar: 'تم التسجيل' },
  PICKUP_SCHEDULED: { en: 'Pickup scheduled', ar: 'استلام مجدول من المرسل' },
  RECEIVED_ORIGIN_WAREHOUSE: { en: 'At origin warehouse', ar: 'استُلمت في مستودع المنشأ' },
  CONSOLIDATED: { en: 'Consolidated (LCL)', ar: 'مجمّعة (LCL)' },
  LOADED: { en: 'Loaded', ar: 'حُمّلت على السفينة' },
  DEPARTED: { en: 'Departed origin port', ar: 'غادرت ميناء المنشأ' },
  IN_TRANSIT: { en: 'In transit by sea', ar: 'في الطريق بحراً' },
  ARRIVED_PORT: { en: 'Arrived at port', ar: 'وصلت ميناء الوجهة' },
  TRIP_SCHEDULED: { en: 'Road trip scheduled', ar: 'رحلة برية مجدولة' },
  ROAD_DEPARTED: { en: 'Departed by road', ar: 'غادرت براً' },
  ROAD_IN_TRANSIT: { en: 'In transit by road', ar: 'في الطريق براً' },
  ROAD_ARRIVED: { en: 'Arrived by road', ar: 'وصلت براً' },
  CUSTOMS_IN_PROGRESS: { en: 'Customs in progress', ar: 'قيد التخليص الجمركي' },
  CUSTOMS_CLEARED: { en: 'Customs cleared', ar: 'تم التخليص' },
  RECEIVED_DESTINATION_WAREHOUSE: { en: 'At destination warehouse', ar: 'في مستودع الوجهة' },
  OUT_FOR_DELIVERY: { en: 'Out for delivery', ar: 'خرجت للتوصيل' },
  PARTIALLY_DELIVERED: { en: 'Partially delivered', ar: 'سُلّم جزء منها' },
  DELIVERED: { en: 'Delivered', ar: 'تم التسليم' },
  CLOSED: { en: 'Closed', ar: 'مغلقة' },
  ON_HOLD: { en: 'On hold', ar: 'متوقفة مؤقتاً' },
  CANCELLED: { en: 'Cancelled', ar: 'ملغاة' },
} as const;

const MODE = {
  SEA: { en: 'Sea', ar: 'بحري' },
  ROAD: { en: 'Road', ar: 'بري' },
} as const;

const CUSTOMS_STATUS = {
  PENDING: { en: 'Pending', ar: 'لم يبدأ' },
  SUBMITTED: { en: 'Submitted', ar: 'مقدَّم' },
  INSPECTION: { en: 'Under inspection', ar: 'قيد المعاينة' },
  HELD: { en: 'Held by customs', ar: 'محجوز لدى الجمارك' },
  CLEARED: { en: 'Cleared', ar: 'تم التخليص' },
} as const;

const TRIP_STATUS = {
  PLANNED: { en: 'Planned', ar: 'مخططة' },
  DEPARTED: { en: 'Departed', ar: 'غادرت' },
  ARRIVED: { en: 'Arrived', ar: 'وصلت' },
  COMPLETED: { en: 'Completed', ar: 'مكتملة' },
  CANCELLED: { en: 'Cancelled', ar: 'ملغاة' },
} as const;

const TRIP_KIND = {
  OWN: { en: 'Own vehicle', ar: 'مركبة مملوكة' },
  EXTERNAL: { en: 'External carrier', ar: 'ناقل خارجي' },
} as const;

const MOVEMENT_KIND = {
  RECEIPT: { en: 'Goods received', ar: 'استلام بضاعة' },
  RELEASE: { en: 'Goods released', ar: 'إخراج بضاعة' },
} as const;

const CONDITION = {
  GOOD: { en: 'Good', ar: 'سليمة' },
  DAMAGED: { en: 'Damaged', ar: 'متضررة' },
} as const;
/** The status of a credit note, supplier bill or payment, or general expense. */
const DOCUMENT_STATUS = {
  DRAFT: { en: 'Draft', ar: 'مسودة' },
  APPROVED: { en: 'Approved', ar: 'معتمد' },
  POSTED: { en: 'Posted', ar: 'مُرحَّل' },
  CANCELLED: { en: 'Cancelled', ar: 'ملغى' },
} as const;

const AUDIT_ENTITY = {
  SHIPMENT: { en: 'Shipment', ar: 'شحنة' },
  WAREHOUSE_MOVEMENT: { en: 'Warehouse movement', ar: 'حركة مستودع' },
  CUSTOMS: { en: 'Customs file', ar: 'ملف جمركي' },
  JOURNAL_ENTRY: { en: 'Journal entry', ar: 'قيد يومية' },
  INVOICE: { en: 'Invoice', ar: 'فاتورة' },
  RECEIPT: { en: 'Receipt', ar: 'سند قبض' },
  CREDIT_NOTE: { en: 'Credit note', ar: 'إشعار دائن' },
  SUPPLIER_BILL: { en: 'Supplier bill', ar: 'فاتورة مورد' },
  SUPPLIER_PAYMENT: { en: 'Supplier payment', ar: 'دفعة لمورد' },
  EXPENSE: { en: 'Expense', ar: 'مصروف' },
  TRIP: { en: 'Trip', ar: 'رحلة' },
  TRIP_EXPENSE: { en: 'Trip expense', ar: 'مصروف رحلة' },
  POD: { en: 'Proof of delivery', ar: 'إثبات تسليم' },
  DOCUMENT: { en: 'Document', ar: 'مستند' },

  RATE: { en: 'Rate', ar: 'سعر' },
  CUSTOMER: { en: 'Customer', ar: 'عميل' },
  USER: { en: 'User account', ar: 'حساب مستخدم' },
} as const;

const AUDIT_ACTION = {
  CREATED: { en: 'Created', ar: 'إنشاء' },
  UPDATED: { en: 'Updated', ar: 'تعديل' },
  STATUS: { en: 'Status change', ar: 'تغيير حالة' },
  HOLD: { en: 'Put on hold', ar: 'إيقاف مؤقت' },
  RESUME: { en: 'Resumed', ar: 'استئناف' },
  REVERT: { en: 'Went back a status', ar: 'رجوع حالة' },
  CANCELLED: { en: 'Cancelled', ar: 'إلغاء' },
  RECEIVED: { en: 'Goods received', ar: 'استلام بضاعة' },
  RELEASED: { en: 'Goods released', ar: 'إخراج بضاعة' },
  FEE_ADDED: { en: 'Fee added', ar: 'إضافة رسم' },
  POSTED: { en: 'Posted', ar: 'ترحيل' },
  APPROVED: { en: 'Approved', ar: 'اعتماد' },
  UPLOADED: { en: 'Uploaded', ar: 'رفع' },
  DELETED: { en: 'Deleted', ar: 'حذف' },
} as const;

/** The fields the audit table records, as AuditChangeDto.field. */
const AUDIT_FIELD = {
  status: { en: 'Status', ar: 'الحالة' },
  originLocationId: { en: 'Origin', ar: 'المنشأ' },
  destinationLocationId: { en: 'Destination', ar: 'الوجهة' },
  mode: { en: 'Mode', ar: 'نوع النقل' },
  loadType: { en: 'Load type', ar: 'نوع الحمولة' },
  cargoType: { en: 'Cargo type', ar: 'نوع البضاعة' },
  containerTypeCode: { en: 'Container', ar: 'الحاوية' },
  chargeTypeCode: { en: 'Charge', ar: 'البند' },
  unit: { en: 'Unit', ar: 'الوحدة' },
  price: { en: 'Price', ar: 'السعر' },
  minimumCharge: { en: 'Minimum charge', ar: 'الحد الأدنى' },
  currency: { en: 'Currency', ar: 'العملة' },
  validFrom: { en: 'Valid from', ar: 'ساري من' },
  validTo: { en: 'Valid to', ar: 'ساري حتى' },
  transitDays: { en: 'Transit days', ar: 'أيام العبور' },
  notes: { en: 'Notes', ar: 'ملاحظات' },
  kind: { en: 'Type', ar: 'النوع' },
  name: { en: 'Name', ar: 'الاسم' },
  companyName: { en: 'Company', ar: 'الشركة' },
  phone: { en: 'Phone', ar: 'الهاتف' },
  whatsapp: { en: 'WhatsApp', ar: 'واتساب' },
  email: { en: 'Email', ar: 'البريد الإلكتروني' },
  countryCode: { en: 'Country', ar: 'الدولة' },
  city: { en: 'City', ar: 'المدينة' },
  address: { en: 'Address', ar: 'العنوان' },
  taxNumber: { en: 'Tax number', ar: 'الرقم الضريبي' },
  preferredCurrency: { en: 'Preferred currency', ar: 'العملة المفضلة' },
  preferredLocale: { en: 'Language', ar: 'اللغة' },
  paymentTermsDays: { en: 'Payment terms (days)', ar: 'مدة السداد (أيام)' },
  creditLimit: { en: 'Credit limit', ar: 'حد الائتمان' },
  creditLimitCurrency: { en: 'Credit limit currency', ar: 'عملة حد الائتمان' },
  isActive: { en: 'Active', ar: 'نشط' },
  fullName: { en: 'Full name', ar: 'الاسم الكامل' },
  roles: { en: 'Roles', ar: 'الأدوار' },
  branches: { en: 'Branches', ar: 'الفروع' },
  password: { en: 'Password', ar: 'كلمة المرور' },
  source: { en: 'Source', ar: 'المصدر' },
  contact: { en: 'Contact', ar: 'جهة الاتصال' },
  party: { en: 'Party', ar: 'طرف' },
  position: { en: 'Position', ar: 'المنصب' },
  idNumber: { en: 'ID number', ar: 'رقم الهوية' },
  canInquire: { en: 'May inquire', ar: 'يحق له الاستفسار' },
  canReceiveCargo: { en: 'May receive cargo', ar: 'يحق له استلام البضاعة' },
  canReceiveDocuments: { en: 'May receive documents', ar: 'يحق له استلام المستندات' },
  isPrimary: { en: 'Primary', ar: 'أساسي' },
} as const;

const EVENT_SOURCE = {
  USER: { en: 'Staff', ar: 'موظف' },
  API: { en: 'API', ar: 'واجهة API' },
  SYSTEM: { en: 'System', ar: 'النظام' },
} as const;

const ENUMS = {
  shipmentStatus: SHIPMENT_STATUS,
  mode: MODE,
  customsStatus: CUSTOMS_STATUS,
  tripStatus: TRIP_STATUS,
  documentStatus: DOCUMENT_STATUS,
  tripKind: TRIP_KIND,
  movementKind: MOVEMENT_KIND,
  condition: CONDITION,
  auditEntity: AUDIT_ENTITY,
  auditAction: AUDIT_ACTION,
  auditField: AUDIT_FIELD,
  eventSource: EVENT_SOURCE,
} as const;

export type OpsLabelKey = keyof typeof LABELS;
export type OpsEnum = keyof typeof ENUMS;

export interface OpsTranslate {
  (key: OpsLabelKey): string;
  /** An enum value's name; the code itself when it is not known. */
  value: (kind: OpsEnum, code: string | null) => string;
}

export function opsTranslator(locale: Locale): OpsTranslate {
  const t = ((key: OpsLabelKey) => LABELS[key][locale]) as OpsTranslate;
  t.value = (kind, code) => {
    if (code === null) return '';
    const names: Partial<Record<string, Record<Locale, string>>> = ENUMS[kind];
    return names[code]?.[locale] ?? code;
  };
  return t;
}
