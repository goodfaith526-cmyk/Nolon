import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  CARGO_TYPES,
  LOAD_TYPES,
  RATE_UNITS,
  SHIPPING_MODES,
  type CreateRateCardRequest,
  type ImportPreviewDto,
  type ImportResultDto,
  type Locale,
  type RateImportColumn,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import type { RuleIssue } from '../common/rule-issues.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { IMPORT_TRANSACTION, lockImportRequest, previousImport } from '../imports/import-commit.js';
import { rowsInvalid } from '../imports/import-http.js';
import { ImportRecordsRegistry } from '../imports/import-records.registry.js';
import {
  type CheckedRow,
  type ImportColumn,
  type Labeled,
  type UploadedWorkbook,
  addIssues,
  buildPreview,
  passingFields,
  flagDuplicatesInFile,
  issue,
  readImportSheet,
  schemaIssues,
} from '../imports/import-sheet.js';
import { importRecordIds, importRequest } from '../imports/request-ids.js';
import { buildTemplate } from '../imports/template.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { createRateBody } from './rate-schemas.js';
import { RatesService, rateKey } from './rates.service.js';

type Column = RateImportColumn;
type Row = CheckedRow<Column, CreateRateCardRequest>;

const AMOUNT_HINT: Labeled = {
  en: 'Amount, digits and a decimal point, e.g. 1250.50 (at most 4 decimals)',
  ar: 'مبلغ بالأرقام مع فاصلة عشرية مثل 1250.50 (4 خانات عشرية كحد أقصى)',
};

/** The rate template (scope 18). Keys match RATE_IMPORT_COLUMNS. */
export const RATE_COLUMNS: readonly ImportColumn<Column>[] = [
  {
    key: 'branchCode',
    kind: 'code',
    required: true,
    list: 'branches',
    label: { en: 'Branch code', ar: 'رمز الفرع' },
    hint: { en: 'One of your branches (Lists sheet)', ar: 'أحد فروعك (ورقة القوائم)' },
  },
  {
    key: 'originCode',
    kind: 'code',
    required: true,
    list: 'locations',
    label: { en: 'Origin code', ar: 'رمز المنشأ' },
    hint: { en: 'Port or city code (Lists sheet)', ar: 'رمز الميناء أو المدينة (ورقة القوائم)' },
  },
  {
    key: 'destinationCode',
    kind: 'code',
    required: true,
    list: 'locations',
    label: { en: 'Destination code', ar: 'رمز الوجهة' },
    hint: {
      en: 'Port or city code, different from the origin',
      ar: 'رمز الميناء أو المدينة، مختلف عن المنشأ',
    },
  },
  {
    key: 'mode',
    kind: 'code',
    required: true,
    list: 'modes',
    label: { en: 'Mode', ar: 'نمط الشحن' },
    hint: { en: 'SEA or ROAD', ar: 'SEA (بحري) أو ROAD (بري)' },
  },
  {
    key: 'loadType',
    kind: 'code',
    required: false,
    list: 'loadTypes',
    label: { en: 'Load type', ar: 'نوع التحميل' },
    hint: { en: 'FCL or LCL, sea rates only', ar: 'FCL أو LCL، للشحن البحري فقط' },
  },
  {
    key: 'cargoType',
    kind: 'code',
    required: true,
    list: 'cargoTypes',
    label: { en: 'Cargo type', ar: 'نوع البضاعة' },
    hint: {
      en: 'CONTAINER, PALLET, BARREL or GENERAL',
      ar: 'CONTAINER أو PALLET أو BARREL أو GENERAL',
    },
  },
  {
    key: 'containerType',
    kind: 'code',
    required: false,
    list: 'containerTypes',
    label: { en: 'Container type', ar: 'نوع الحاوية' },
    hint: {
      en: 'Required for CONTAINER cargo, empty otherwise (Lists sheet)',
      ar: 'إلزامي لبضاعة CONTAINER، ويُترك فارغاً لغيرها (ورقة القوائم)',
    },
  },
  {
    key: 'chargeType',
    kind: 'code',
    required: false,
    list: 'chargeTypes',
    label: { en: 'Charge type', ar: 'نوع الرسم' },
    hint: { en: 'Default FREIGHT (Lists sheet)', ar: 'الافتراضي FREIGHT (ورقة القوائم)' },
  },
  {
    key: 'unit',
    kind: 'code',
    required: true,
    list: 'units',
    label: { en: 'Unit', ar: 'الوحدة' },
    hint: { en: 'Pricing unit (Lists sheet)', ar: 'وحدة التسعير (ورقة القوائم)' },
  },
  {
    key: 'price',
    kind: 'amount',
    required: true,
    label: { en: 'Price', ar: 'السعر' },
    hint: AMOUNT_HINT,
  },
  {
    key: 'minimumCharge',
    kind: 'amount',
    required: false,
    label: { en: 'Minimum charge', ar: 'الحد الأدنى للرسوم' },
    hint: { en: `${AMOUNT_HINT.en}; default 0`, ar: `${AMOUNT_HINT.ar}؛ الافتراضي 0` },
  },
  {
    key: 'currency',
    kind: 'code',
    required: true,
    list: 'currencies',
    label: { en: 'Currency', ar: 'العملة' },
    hint: { en: 'An active currency (Lists sheet)', ar: 'عملة مفعّلة (ورقة القوائم)' },
  },
  {
    key: 'validFrom',
    kind: 'date',
    required: true,
    label: { en: 'Valid from', ar: 'ساري من' },
    hint: { en: 'Date, YYYY-MM-DD', ar: 'تاريخ بصيغة YYYY-MM-DD' },
  },
  {
    key: 'validTo',
    kind: 'date',
    required: false,
    label: { en: 'Valid to', ar: 'ساري حتى' },
    hint: {
      en: 'Date, YYYY-MM-DD, not before valid from; empty for open-ended',
      ar: 'تاريخ بصيغة YYYY-MM-DD لا يسبق تاريخ البداية؛ فارغ لسعر مفتوح',
    },
  },
  {
    key: 'transitDays',
    kind: 'integer',
    required: false,
    label: { en: 'Transit days', ar: 'أيام العبور' },
    hint: { en: 'Whole number 0 to 365', ar: 'عدد صحيح من 0 إلى 365' },
  },
  {
    key: 'notes',
    kind: 'text',
    required: false,
    width: 36,
    label: { en: 'Notes', ar: 'ملاحظات' },
    hint: { en: 'Up to 2000 characters', ar: 'حتى 2000 حرف' },
  },
];

const ENUM_LABELS: Record<string, Labeled> = {
  SEA: { en: 'Sea', ar: 'بحري' },
  ROAD: { en: 'Road', ar: 'بري' },
  FCL: { en: 'Full container load', ar: 'حاوية كاملة' },
  LCL: { en: 'Less than container load', ar: 'شحنة مجمّعة' },
  CONTAINER: { en: 'Container', ar: 'حاويات' },
  PALLET: { en: 'Pallets', ar: 'طبالي' },
  BARREL: { en: 'Barrels', ar: 'براميل' },
  GENERAL: { en: 'General cargo', ar: 'بضائع عامة' },
  PER_CONTAINER: { en: 'per container', ar: 'لكل حاوية' },
  PER_CBM: { en: 'per CBM', ar: 'لكل متر مكعب' },
  PER_KG: { en: 'per kg', ar: 'لكل كغ' },
  PER_PALLET: { en: 'per pallet', ar: 'لكل طبلية' },
  PER_BARREL: { en: 'per barrel', ar: 'لكل برميل' },
  PER_PIECE: { en: 'per piece', ar: 'لكل قطعة' },
  PER_SHIPMENT: { en: 'per shipment', ar: 'لكل شحنة' },
};

/** Request field of each column. */
const FIELD_OF: Record<Column, string> = {
  branchCode: 'branchId',
  originCode: 'originLocationId',
  destinationCode: 'destinationLocationId',
  mode: 'mode',
  loadType: 'loadType',
  cargoType: 'cargoType',
  containerType: 'containerTypeCode',
  chargeType: 'chargeTypeCode',
  unit: 'unit',
  price: 'price',
  minimumCharge: 'minimumCharge',
  currency: 'currency',
  validFrom: 'validFrom',
  validTo: 'validTo',
  transitDays: 'transitDays',
  notes: 'notes',
};

function columnOf(field: string): Column | null {
  return RATE_COLUMNS.find((c) => FIELD_OF[c.key] === field)?.key ?? null;
}

function kindOf(column: Column) {
  return RATE_COLUMNS.find((c) => c.key === column)?.kind;
}

/**
 * Excel import of selling rates (scope 7 and 18). Each row is checked with the same request
 * schema and rules as POST /rates (route, load and container type, charge type, currency,
 * validity), plus duplicates: the same offer (branch, route, mode, load, cargo, container,
 * charge, unit, currency and start date) twice in the file, or as a draft or approved rate of the
 * branch (the rule RatesService enforces on every write). Rows are imported as drafts and approved through the normal workflow.
 */
@Injectable()
export class RatesImportService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importRecords: ImportRecordsRegistry,
    private readonly rates: RatesService,
    private readonly masterData: MasterDataService,
    private readonly currencies: CurrenciesService,
  ) {}

  onModuleInit(): void {
    this.importRecords.register('rates', (client, { from, to }, take) =>
      client.rateCard.findMany({
        where: { id: { gte: from, lte: to } },
        select: { id: true, branchId: true },
        take,
      }),
    );
  }

  async template(user: AuthUser, locale: Locale): Promise<{ fileName: string; data: Buffer }> {
    const [branches, master, currencies] = await Promise.all([
      this.userBranches(user),
      this.masterData.all(),
      this.currencies.listActive(),
    ]);
    const name = (n: { nameEn: string; nameAr: string }) => (locale === 'ar' ? n.nameAr : n.nameEn);
    const enumList = (values: readonly string[]) =>
      values.map((code) => ({ code, name: ENUM_LABELS[code]?.[locale] ?? code }));
    const data = await buildTemplate({
      locale,
      sheetName: { en: 'Rates', ar: 'الأسعار' },
      columns: RATE_COLUMNS,
      notes: [
        {
          en: 'Each row creates a new draft rate; a user with approval rights approves it before quotations can use it.',
          ar: 'كل صف يُنشئ سعراً جديداً كمسودة، ويعتمده صاحب صلاحية الاعتماد قبل استخدامه في عروض الأسعار.',
        },
      ],
      lists: [
        {
          key: 'branches',
          title: { en: 'Branches', ar: 'الفروع' },
          items: branches.map((b) => ({ code: b.code, name: name(b) })),
        },
        {
          key: 'locations',
          title: { en: 'Ports and cities', ar: 'الموانئ والمدن' },
          items: master.locations
            .filter((l) => l.isActive)
            .map((l) => ({ code: l.code, name: `${name(l)} (${l.countryCode})` })),
        },
        {
          key: 'currencies',
          title: { en: 'Currencies', ar: 'العملات' },
          items: currencies.map((c) => ({ code: c.code, name: name(c) })),
        },
        {
          key: 'containerTypes',
          title: { en: 'Container types', ar: 'أنواع الحاويات' },
          items: master.containerTypes
            .filter((c) => c.isActive)
            .map((c) => ({ code: c.code, name: name(c) })),
        },
        {
          key: 'chargeTypes',
          title: { en: 'Charge types', ar: 'أنواع الرسوم' },
          items: master.chargeTypes
            .filter((c) => c.isActive)
            .map((c) => ({ code: c.code, name: name(c) })),
        },
        {
          key: 'modes',
          title: { en: 'Modes', ar: 'أنماط الشحن' },
          items: enumList(SHIPPING_MODES),
        },
        {
          key: 'loadTypes',
          title: { en: 'Load types', ar: 'أنواع التحميل' },
          items: enumList(LOAD_TYPES),
        },
        {
          key: 'cargoTypes',
          title: { en: 'Cargo types', ar: 'أنواع البضاعة' },
          items: enumList(CARGO_TYPES),
        },
        { key: 'units', title: { en: 'Units', ar: 'الوحدات' }, items: enumList(RATE_UNITS) },
      ],
    });
    return { fileName: `nolon-rates-template-${locale}.xlsx`, data };
  }

  async preview(user: AuthUser, file: UploadedWorkbook | undefined): Promise<ImportPreviewDto> {
    return buildPreview('rates', RATE_COLUMNS, await this.check(user, file));
  }

  /**
   * Imports every row in one transaction. Any invalid row refuses the whole file (422, with the
   * preview); the user fixes the file and uploads it again. A retry of the same file by the same
   * user with the same requestId answers with the first attempt's result and writes nothing; the
   * requestId reused for anything else is refused (409).
   *
   * Inside the transaction, RatesService checks again, under the locks every rate write takes,
   * that each branch is still active and that no row repeats a rate written meanwhile (by another
   * import or a single create or update); any such row refuses the file.
   */
  async commit(
    user: AuthUser,
    file: UploadedWorkbook | undefined,
    requestId: string,
  ): Promise<ImportResultDto> {
    const request = importRequest('rates', requestId, user.id, file?.buffer ?? Buffer.alloc(0));
    const done = await previousImport(this.importRecords.lookups(), this.prisma, user, request);
    if (done) return done;
    const rows = await this.check(user, file);
    const invalid = () => rowsInvalid(buildPreview('rates', RATE_COLUMNS, rows));
    const ready = rows.flatMap((r) =>
      r.input && r.issues.length === 0 ? [{ row: r, input: r.input }] : [],
    );
    if (ready.length < rows.length) throw invalid();
    const ids = importRecordIds(request, rows.length);
    return this.prisma.$transaction(async (tx) => {
      await lockImportRequest(tx, requestId);
      const raced = await previousImport(this.importRecords.lookups(), tx, user, request);
      if (raced) return raced;
      const issues = await this.rates.createImported(
        tx,
        user,
        ready.map((r, i) => ({ id: ids[i] ?? '', input: r.input })),
      );
      ready.forEach((r, i) => addRuleIssues(r.row, issues[i] ?? []));
      if (rows.some((r) => r.issues.length > 0)) throw invalid();
      return { kind: 'rates', requestId, created: rows.length, replayed: false, ids };
    }, IMPORT_TRANSACTION);
  }

  private userBranches(user: AuthUser) {
    return this.prisma.branch.findMany({
      where: { id: { in: [...user.allowedBranchIds] }, isActive: true },
      orderBy: { code: 'asc' },
    });
  }

  private async check(user: AuthUser, file: UploadedWorkbook | undefined): Promise<Row[]> {
    const sheet = await readImportSheet(file, RATE_COLUMNS);
    const [branches, master] = await Promise.all([this.userBranches(user), this.masterData.all()]);
    const branchIds = new Map(branches.map((b) => [b.code, b.id]));
    // Every location code, active or not: an inactive one is reported by the rate rules.
    const locationIds = new Map(master.locations.map((l) => [l.code, l.id]));
    const checkRules = this.rates.ruleChecker();
    const rows: Row[] = [];
    for (const { row, values, issues } of sheet) {
      const input: Record<string, unknown> = {};
      for (const column of RATE_COLUMNS) {
        const value = values[column.key];
        if (value !== null) input[FIELD_OF[column.key]] = value;
      }
      const resolve = (
        column: 'branchCode' | 'originCode' | 'destinationCode',
        ids: Map<string, string>,
        refused: () => ReturnType<typeof issue>,
      ) => {
        const code = values[column];
        if (typeof code !== 'string') return;
        const id = ids.get(code);
        if (id) input[FIELD_OF[column]] = id;
        else {
          delete input[FIELD_OF[column]];
          addIssues(issues, [refused()]);
        }
      };
      resolve('branchCode', branchIds, () =>
        issue(row, 'branchCode', 'BRANCH_NOT_ALLOWED', 'Not one of your active branches'),
      );
      resolve('originCode', locationIds, () =>
        issue(row, 'originCode', 'UNKNOWN_LOCATION', 'Unknown location code'),
      );
      resolve('destinationCode', locationIds, () =>
        issue(row, 'destinationCode', 'UNKNOWN_LOCATION', 'Unknown location code'),
      );
      const parsed = createRateBody.safeParse(input);
      const checked: Row = { row, values, issues, input: null };
      if (parsed.success) {
        checked.input = parsed.data;
        const ruleIssues = await checkRules(parsed.data);
        addIssues(
          issues,
          ruleIssues.map((r) => issue(row, columnOf(r.field), r.code, r.message)),
        );
      } else {
        addIssues(issues, schemaIssues(row, input, parsed.error, columnOf, kindOf));
        const rest = passingFields(createRateBody, input, parsed.error);
        if (rest) {
          addIssues(
            issues,
            (await checkRules(rest)).map((r) => issue(row, columnOf(r.field), r.code, r.message)),
          );
        }
      }
      rows.push(checked);
    }
    flagDuplicatesInFile(rows, (input) => [
      {
        key: rateKey(input),
        column: 'validFrom',
        what: 'rate (route, cargo, unit, currency, start)',
      },
    ]);
    const parsed = rows.flatMap((r) => (r.input ? [{ row: r, input: r.input }] : []));
    const duplicates = await this.rates.duplicateIssues(
      this.prisma,
      parsed.map((p) => p.input),
    );
    parsed.forEach((p, i) => addRuleIssues(p.row, duplicates[i] ?? []));
    return rows;
  }
}

function addRuleIssues(row: Row, issues: readonly RuleIssue[]): void {
  addIssues(
    row.issues,
    issues.map((r) => issue(row.row, columnOf(r.field), r.code, r.message)),
  );
}
