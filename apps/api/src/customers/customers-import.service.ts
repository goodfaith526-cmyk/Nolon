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
import { branchScope } from '../auth/branch-scope.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  IMPORT_TRANSACTION,
  lockImportBranches,
  lockImportRequest,
  previousImport,
} from '../imports/import-commit.js';
import { rowsInvalid } from '../imports/import-http.js';
import { ImportRecordsRegistry } from '../imports/import-records.registry.js';
import {
  type CheckedRow,
  type ImportColumn,
  type UploadedWorkbook,
  addIssues,
  buildPreview,
  flagDuplicatesInFile,
  issue,
  readImportSheet,
  schemaIssues,
} from '../imports/import-sheet.js';
import { importRecordIds, importRequest } from '../imports/request-ids.js';
import { buildTemplate } from '../imports/template.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { createCustomerBody } from './customer-schemas.js';
import { CustomersService } from './customers.service.js';

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
      en: 'International form, e.g. +249912345678. Checked on import: not already used in the branch.',
      ar: 'بالصيغة الدولية مثل ‎+249912345678. يُتحقَّق عند الاستيراد من أنه غير مستخدم في الفرع.',
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
      en: 'Up to 50 characters. Checked on import: not already used in the branch.',
      ar: 'حتى 50 حرفاً. يُتحقَّق عند الاستيراد من أنه غير مستخدم في الفرع.',
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

const normalizeTax = (value: string) => value.trim().toUpperCase();

/**
 * Excel import of customers (scope 6 and 18). Each row is checked with the same request schema
 * and reference rules as POST /customers, plus an import-only duplicate check: a phone or tax
 * number repeated within the file, or already held by a customer of the same branch. Commit
 * writes every row in one transaction, or nothing when any row fails.
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
      columns: CUSTOMER_COLUMNS,
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
    return buildPreview('customers', CUSTOMER_COLUMNS, await this.check(user, file));
  }

  /**
   * Imports every row in one transaction. Any invalid row refuses the whole file (422, with the
   * preview); the user fixes the file and uploads it again. A retry of the same file by the same
   * user with the same requestId answers with the first attempt's result and writes nothing; the
   * requestId reused for anything else is refused (409).
   *
   * The duplicate check runs again inside the transaction, under a lock per branch of the file,
   * so two imports into one branch cannot both pass it with the same phone or tax number.
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
    const invalid = () => rowsInvalid(buildPreview('customers', CUSTOMER_COLUMNS, rows));
    if (rows.some((r) => r.issues.length > 0 || !r.input)) throw invalid();
    const ids = importRecordIds(request, rows.length);
    return this.prisma.$transaction(async (tx) => {
      await lockImportRequest(tx, requestId);
      const raced = await previousImport(this.importRecords.lookups(), tx, user, request);
      if (raced) return raced;
      await lockImportBranches(
        tx,
        'customers',
        rows.flatMap((r) => (r.input ? [r.input.branchId] : [])),
      );
      await this.flagExisting(tx, user, rows);
      if (rows.some((r) => r.issues.length > 0)) throw invalid();
      await this.customers.createImported(
        tx,
        user,
        rows.flatMap((r, i) => (r.input ? [{ id: ids[i] ?? '', input: r.input }] : [])),
      );
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
    const sheet = await readImportSheet(file, CUSTOMER_COLUMNS);
    const branchIds = new Map((await this.userBranches(user)).map((b) => [b.code, b.id]));
    const checkReferences = this.customers.referenceChecker();
    const rows: Row[] = [];
    for (const { row, values, issues } of sheet) {
      const input: Record<string, unknown> = {};
      for (const column of CUSTOMER_COLUMNS) {
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
      }
      if (typeof input.preferredLocale === 'string') {
        input.preferredLocale = input.preferredLocale.toLowerCase();
      }
      const parsed = createCustomerBody.safeParse(input);
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
      }
      rows.push(checked);
    }
    flagDuplicatesInFile(rows, (input) => [
      { key: `phone|${input.branchId}|${input.phone}`, column: 'phone', what: 'phone' },
      ...(input.taxNumber
        ? [
            {
              key: `tax|${input.branchId}|${normalizeTax(input.taxNumber)}`,
              column: 'taxNumber' as const,
              what: 'tax number',
            },
          ]
        : []),
    ]);
    await this.flagExisting(this.prisma, user, rows);
    return rows;
  }

  /** Rows whose phone or tax number a customer of the same branch already has. */
  private async flagExisting(
    client: Prisma.TransactionClient,
    user: AuthUser,
    rows: Row[],
  ): Promise<void> {
    const inputs = rows.flatMap((r) => (r.input ? [r.input] : []));
    if (inputs.length === 0) return;
    const phones = [...new Set(inputs.map((i) => i.phone))];
    const taxes = [...new Set(inputs.flatMap((i) => (i.taxNumber ? [i.taxNumber] : [])))];
    const existing = await client.customer.findMany({
      where: {
        ...branchScope(user),
        OR: [
          { phone: { in: phones } },
          ...(taxes.length > 0 ? [{ taxNumber: { in: taxes, mode: 'insensitive' as const } }] : []),
        ],
      },
      select: { branchId: true, number: true, phone: true, taxNumber: true },
    });
    const byPhone = new Map(existing.map((c) => [`${c.branchId}|${c.phone}`, c.number]));
    const byTax = new Map(
      existing.flatMap((c) =>
        c.taxNumber ? [[`${c.branchId}|${normalizeTax(c.taxNumber)}`, c.number] as const] : [],
      ),
    );
    for (const row of rows) {
      if (!row.input) continue;
      const { branchId, phone, taxNumber } = row.input;
      const samePhone = byPhone.get(`${branchId}|${phone}`);
      if (samePhone) {
        addIssues(row.issues, [
          issue(row.row, 'phone', 'DUPLICATE_IN_DB', `Customer ${samePhone} has this phone`),
        ]);
      }
      const sameTax = taxNumber ? byTax.get(`${branchId}|${normalizeTax(taxNumber)}`) : undefined;
      if (sameTax) {
        addIssues(row.issues, [
          issue(row.row, 'taxNumber', 'DUPLICATE_IN_DB', `Customer ${sameTax} has this tax number`),
        ]);
      }
    }
  }
}
