import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  CUSTOMER_KINDS,
  type CreateCustomerRequest,
  type CustomerImportColumn,
  type ImportPreviewDto,
  type ImportResultDto,
  type Locale,
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
import { PrismaService } from '../prisma/prisma.service.js';
import { importCustomerBody } from './customer-schemas.js';
import { CustomersService, normalizeTaxNumber } from './customers.service.js';

type Column = CustomerImportColumn;
type Row = CheckedRow<Column, CreateCustomerRequest>;

/** The customer template (scope 18). Keys match CUSTOMER_IMPORT_COLUMNS. */
export const CUSTOMER_COLUMNS: readonly ImportColumn<Column>[] = [
  {
    key: 'branchCode',
    kind: 'code',
    required: true,
    list: 'branches',
    label: { en: 'Branch code', ar: 'رمز الفرع' },
    hint: { en: 'One of your branches (Lists sheet)', ar: 'أحد فروعك (ورقة القوائم)' },
  },
  {
    key: 'kind',
    kind: 'code',
    required: true,
    list: 'kinds',
    label: { en: 'Customer type', ar: 'نوع العميل' },
    hint: { en: 'COMPANY or INDIVIDUAL', ar: 'COMPANY (شركة) أو INDIVIDUAL (فرد)' },
  },
  {
    key: 'name',
    kind: 'text',
    required: true,
    width: 30,
    label: { en: 'Name', ar: 'الاسم' },
    hint: { en: 'Up to 200 characters', ar: 'حتى 200 حرف' },
  },
  {
    key: 'companyName',
    kind: 'text',
    required: false,
    width: 30,
    label: { en: 'Company name', ar: 'اسم الشركة' },
    hint: { en: 'Up to 200 characters', ar: 'حتى 200 حرف' },
  },
  {
    key: 'phone',
    kind: 'phone',
    required: true,
    label: { en: 'Phone', ar: 'الهاتف' },
    hint: {
      en: 'International form, e.g. +249912345678. Unique per branch.',
      ar: 'بالصيغة الدولية مثل ‎+249912345678. لا يتكرر داخل الفرع.',
    },
  },
  {
    key: 'whatsapp',
    kind: 'phone',
    required: false,
    label: { en: 'WhatsApp', ar: 'واتساب' },
    hint: {
      en: 'International form, e.g. +249912345678',
      ar: 'بالصيغة الدولية مثل ‎+249912345678',
    },
  },
  {
    key: 'email',
    kind: 'text',
    required: false,
    width: 28,
    label: { en: 'Email', ar: 'البريد الإلكتروني' },
    hint: { en: 'A valid email address', ar: 'عنوان بريد صحيح' },
  },
  {
    key: 'countryCode',
    kind: 'code',
    required: false,
    label: { en: 'Country code', ar: 'رمز الدولة' },
    hint: { en: 'Two letters (ISO), e.g. SD, AE, SA', ar: 'حرفان (ISO) مثل SD أو AE أو SA' },
  },
  {
    key: 'city',
    kind: 'text',
    required: false,
    label: { en: 'City', ar: 'المدينة' },
    hint: { en: 'Up to 100 characters', ar: 'حتى 100 حرف' },
  },
  {
    key: 'address',
    kind: 'text',
    required: false,
    width: 36,
    label: { en: 'Address', ar: 'العنوان' },
    hint: { en: 'Up to 500 characters', ar: 'حتى 500 حرف' },
  },
  {
    key: 'taxNumber',
    kind: 'text',
    required: false,
    label: { en: 'Tax number', ar: 'الرقم الضريبي' },
    hint: {
      en: 'Up to 50 characters. Unique per branch (case does not matter).',
      ar: 'حتى 50 حرفاً. لا يتكرر داخل الفرع (دون اعتبار لحالة الأحرف).',
    },
  },
  {
    key: 'preferredCurrency',
    kind: 'code',
    required: false,
    list: 'currencies',
    label: { en: 'Preferred currency', ar: 'العملة المفضلة' },
    hint: { en: 'An active currency (Lists sheet)', ar: 'عملة مفعّلة (ورقة القوائم)' },
  },
  {
    key: 'preferredLocale',
    kind: 'code',
    required: false,
    list: 'locales',
    label: { en: 'Language', ar: 'اللغة' },
    hint: { en: 'AR or EN (default AR)', ar: 'AR أو EN (الافتراضي AR)' },
  },
  {
    key: 'paymentTermsDays',
    kind: 'integer',
    required: false,
    label: { en: 'Payment terms (days)', ar: 'مدة السداد (أيام)' },
    hint: { en: 'Whole number 0 to 365 (default 0)', ar: 'عدد صحيح من 0 إلى 365 (الافتراضي 0)' },
  },
  {
    key: 'creditLimit',
    kind: 'amount',
    required: false,
    label: { en: 'Credit limit', ar: 'حد الائتمان' },
    hint: {
      en: 'Amount, e.g. 5000.50; needs the credit limit currency',
      ar: 'مبلغ مثل 5000.50، ويلزمه عملة حد الائتمان',
    },
  },
  {
    key: 'creditLimitCurrency',
    kind: 'code',
    required: false,
    list: 'currencies',
    label: { en: 'Credit limit currency', ar: 'عملة حد الائتمان' },
    hint: { en: 'An active currency (Lists sheet)', ar: 'عملة مفعّلة (ورقة القوائم)' },
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

/**
 * The template's columns for this user. A user with one branch may leave the branch code empty
 * (or leave the column out): the row is for that branch (`check`). Everyone else names it.
 */
function columnsFor(user: AuthUser): readonly ImportColumn<Column>[] {
  if (user.allowedBranchIds.length !== 1) return CUSTOMER_COLUMNS;
  return CUSTOMER_COLUMNS.map((c) =>
    c.key === 'branchCode'
      ? {
          ...c,
          required: false,
          hint: {
            en: 'Your branch (Lists sheet); empty means your branch',
            ar: 'فرعك (ورقة القوائم)؛ إذا تُرك فارغاً فهو فرعك',
          },
        }
      : c,
  );
}

const KIND_LABELS = {
  COMPANY: { en: 'Company', ar: 'شركة' },
  INDIVIDUAL: { en: 'Individual', ar: 'فرد' },
} as const;

/** Request field of each column (the same name, except the branch, given by its code). */
function fieldOf(column: Column): string {
  return column === 'branchCode' ? 'branchId' : column;
}

function columnOf(field: string): Column | null {
  if (field === 'branchId') return 'branchCode';
  return CUSTOMER_COLUMNS.find((c) => c.key === field)?.key ?? null;
}

function kindOf(column: Column) {
  return CUSTOMER_COLUMNS.find((c) => c.key === column)?.kind;
}

/**
 * Excel import of customers (scope 6 and 18). Each row is checked with the same request schema
 * and reference rules as POST /customers, plus duplicates: a phone or tax number repeated within
 * the file, or already held by a customer of the same branch (the rule CustomersService enforces
 * on every write). Commit writes every row in one transaction, or nothing when any row fails.
 */
@Injectable()
export class CustomersImportService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importRecords: ImportRecordsRegistry,
    private readonly customers: CustomersService,
    private readonly currencies: CurrenciesService,
  ) {}

  onModuleInit(): void {
    this.importRecords.register('customers', (client, { from, to }, take) =>
      client.customer.findMany({
        where: { id: { gte: from, lte: to } },
        select: { id: true, branchId: true },
        take,
      }),
    );
  }

  async template(user: AuthUser, locale: Locale): Promise<{ fileName: string; data: Buffer }> {
    const [branches, currencies] = await Promise.all([
      this.userBranches(user),
      this.currencies.listActive(),
    ]);
    const name = (n: { nameEn: string; nameAr: string }) => (locale === 'ar' ? n.nameAr : n.nameEn);
    const data = await buildTemplate({
      locale,
      sheetName: { en: 'Customers', ar: 'العملاء' },
      columns: columnsFor(user),
      notes: [
        {
          en: 'Each row creates a new customer with the next customer number. Existing customers are never changed.',
          ar: 'كل صف يُنشئ عميلاً جديداً برقم العميل التالي. لا يُعدَّل أي عميل موجود.',
        },
      ],
      lists: [
        {
          key: 'branches',
          title: { en: 'Branches', ar: 'الفروع' },
          items: branches.map((b) => ({ code: b.code, name: name(b) })),
        },
        {
          key: 'currencies',
          title: { en: 'Currencies', ar: 'العملات' },
          items: currencies.map((c) => ({ code: c.code, name: name(c) })),
        },
        {
          key: 'kinds',
          title: { en: 'Customer types', ar: 'أنواع العملاء' },
          items: CUSTOMER_KINDS.map((k) => ({ code: k, name: KIND_LABELS[k][locale] })),
        },
        {
          key: 'locales',
          title: { en: 'Languages', ar: 'اللغات' },
          items: [
            { code: 'AR', name: locale === 'ar' ? 'العربية' : 'Arabic' },
            { code: 'EN', name: locale === 'ar' ? 'الإنجليزية' : 'English' },
          ],
        },
      ],
    });
    return { fileName: `nolon-customers-template-${locale}.xlsx`, data };
  }

  async preview(user: AuthUser, file: UploadedWorkbook | undefined): Promise<ImportPreviewDto> {
    return buildPreview('customers', columnsFor(user), await this.check(user, file));
  }

  /**
   * Imports every row in one transaction. Any invalid row refuses the whole file (422, with the
   * preview); the user fixes the file and uploads it again. A retry of the same file by the same
   * user with the same requestId answers with the first attempt's result and writes nothing; the
   * requestId reused for anything else is refused (409).
   *
   * Inside the transaction, CustomersService checks again, under the locks every customer write
   * takes, that each branch is still active and that no phone or tax number has been taken
   * meanwhile (by another import or a single create or update); any such row refuses the file.
   */
  async commit(
    user: AuthUser,
    file: UploadedWorkbook | undefined,
    requestId: string,
  ): Promise<ImportResultDto> {
    const request = importRequest('customers', requestId, user.id, file?.buffer ?? Buffer.alloc(0));
    const done = await previousImport(this.importRecords.lookups(), this.prisma, user, request);
    if (done) return done;
    const rows = await this.check(user, file);
    const invalid = () => rowsInvalid(buildPreview('customers', columnsFor(user), rows));
    const ready = rows.flatMap((r) =>
      r.input && r.issues.length === 0 ? [{ row: r, input: r.input }] : [],
    );
    if (ready.length < rows.length) throw invalid();
    const ids = importRecordIds(request, rows.length);
    return this.prisma.$transaction(async (tx) => {
      await lockImportRequest(tx, requestId);
      const raced = await previousImport(this.importRecords.lookups(), tx, user, request);
      if (raced) return raced;
      const issues = await this.customers.createImported(
        tx,
        user,
        ready.map((r, i) => ({ id: ids[i] ?? '', input: r.input })),
      );
      ready.forEach((r, i) => addRuleIssues(r.row, issues[i] ?? []));
      if (rows.some((r) => r.issues.length > 0)) throw invalid();
      return { kind: 'customers', requestId, created: rows.length, replayed: false, ids };
    }, IMPORT_TRANSACTION);
  }

  /** The user's active branches: the only ones a row may name. */
  private userBranches(user: AuthUser) {
    return this.prisma.branch.findMany({
      where: { id: { in: [...user.allowedBranchIds] }, isActive: true },
      orderBy: { code: 'asc' },
    });
  }

  private async check(user: AuthUser, file: UploadedWorkbook | undefined): Promise<Row[]> {
    const columns = columnsFor(user);
    const sheet = await readImportSheet(file, columns);
    const branches = await this.userBranches(user);
    const branchIds = new Map(branches.map((b) => [b.code, b.id]));
    // A user with one branch (taken from the session on every preview and commit, so a branch
    // removed from them meanwhile is not used): an empty branch code is that branch.
    const [only] = user.allowedBranchIds.length === 1 ? user.allowedBranchIds : [];
    const checkReferences = this.customers.referenceChecker();
    const rows: Row[] = [];
    for (const { row, values, issues } of sheet) {
      const input: Record<string, unknown> = {};
      for (const column of columns) {
        const value = values[column.key];
        if (value !== null) input[fieldOf(column.key)] = value;
      }
      if (typeof values.branchCode === 'string') {
        const id = branchIds.get(values.branchCode);
        if (id) {
          input.branchId = id;
        } else {
          delete input.branchId;
          addIssues(issues, [
            issue(row, 'branchCode', 'BRANCH_NOT_ALLOWED', 'Not one of your active branches'),
          ]);
        }
      } else if (
        values.branchCode === null &&
        only !== undefined &&
        // A code that could not be read is reported as it is, not replaced.
        !issues.some((i) => i.column === 'branchCode')
      ) {
        if (branches.some((b) => b.id === only)) {
          input.branchId = only;
        } else {
          addIssues(issues, [
            issue(row, 'branchCode', 'BRANCH_NOT_ALLOWED', 'Not one of your active branches'),
          ]);
        }
      }
      if (typeof input.preferredLocale === 'string') {
        input.preferredLocale = input.preferredLocale.toLowerCase();
      }
      const parsed = importCustomerBody.safeParse(input);
      const checked: Row = { row, values, issues, input: null };
      if (parsed.success) {
        checked.input = parsed.data;
        const ruleIssues = await checkReferences(parsed.data);
        addIssues(
          issues,
          ruleIssues.map((r) => issue(row, columnOf(r.field), r.code, r.message)),
        );
      } else {
        addIssues(issues, schemaIssues(row, input, parsed.error, columnOf, kindOf));
        const rest = passingFields(importCustomerBody, input, parsed.error);
        if (rest) {
          addIssues(
            issues,
            (await checkReferences(rest)).map((r) =>
              issue(row, columnOf(r.field), r.code, r.message),
            ),
          );
        }
      }
      rows.push(checked);
    }
    flagDuplicatesInFile(rows, (input) => [
      { key: `phone|${input.branchId}|${input.phone}`, column: 'phone', what: 'phone' },
      ...(input.taxNumber
        ? [
            {
              key: `tax|${input.branchId}|${normalizeTaxNumber(input.taxNumber)}`,
              column: 'taxNumber' as const,
              what: 'tax number',
            },
          ]
        : []),
    ]);
    const parsed = rows.flatMap((r) => (r.input ? [{ row: r, input: r.input }] : []));
    const duplicates = await this.customers.duplicateIssues(
      this.prisma,
      parsed.map((p) => p.input),
      user,
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
