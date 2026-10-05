import { randomInt, randomUUID } from 'node:crypto';
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  type ImportFileErrorBody,
  type ImportPreviewDto,
  type ImportResultDto,
  type ImportRowsInvalidBody,
} from '@nolon/shared';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import { lockBranchRule } from '../src/common/branch-locks.js';
import { CUSTOMER_UNIQUE_RULE } from '../src/customers/customers.service.js';
import { lockImportRequest } from '../src/imports/import-commit.js';
import { RATE_UNIQUE_RULE } from '../src/rates/rates.service.js';
import { deleteCommercialTestData, waitForLockWaiter } from './test-data.js';
import { lyingZipBomb } from './zip-bomb.js';

const CUSTOMER_HEADER = [
  'Branch code',
  'Customer type',
  'Name',
  'Phone',
  'Tax number',
  'Preferred currency',
  'Payment terms (days)',
  'Credit limit',
  'Credit limit currency',
];

const RATE_HEADER = [
  'رمز الفرع',
  'رمز المنشأ',
  'رمز الوجهة',
  'نمط الشحن',
  'نوع التحميل',
  'نوع البضاعة',
  'نوع الحاوية',
  'الوحدة',
  'السعر',
  'العملة',
  'ساري من',
  'ساري حتى',
];

async function xlsx(rows: ExcelJS.CellValue[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A phone no other suite uses. */
function phone(): string {
  return `+2499${String(randomInt(10_000_000, 99_999_999))}`;
}

describe('Excel import of customers and rates', () => {
  let t: TestApp;
  let dxb: string;
  /** A branch of its own, deactivated and reactivated by the branch-state tests. */
  let zzi: string;
  const cookies = {
    admin: '',
    salesDxb: '',
    salesJed: '',
    opsDxb: '',
    managerDxb: '',
    salesZzi: '',
  };
  // A start date of its own, so the rate duplicates checked here are only this run's.
  const day = `2031-${String(randomInt(1, 13)).padStart(2, '0')}-${String(randomInt(1, 29)).padStart(2, '0')}`;

  const upload = (path: string, cookie: string, data: Buffer, name = 'import.xlsx') =>
    t
      .http()
      .post(`/api/v1${path}`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .attach('file', data, name);

  const commit = (path: string, cookie: string, data: Buffer, requestId: string) =>
    upload(path, cookie, data).field('requestId', requestId);

  const myCustomers = () =>
    t.prisma.customer.count({ where: { createdBy: { email: { startsWith: 'it-' } } } });
  const myRates = () =>
    t.prisma.rateCard.count({ where: { createdBy: { email: { startsWith: 'it-' } } } });

  function customerRow(
    overrides: Partial<Record<string, ExcelJS.CellValue>> = {},
  ): ExcelJS.CellValue[] {
    const row: Record<string, ExcelJS.CellValue> = {
      branch: 'DXB',
      kind: 'COMPANY',
      name: 'Imported Trading',
      phone: phone(),
      tax: null,
      currency: 'USD',
      terms: 30,
      limit: '5000.25',
      limitCurrency: 'USD',
      ...overrides,
    };
    return [
      row.branch,
      row.kind,
      row.name,
      row.phone,
      row.tax,
      row.currency,
      row.terms,
      row.limit,
      row.limitCurrency,
    ].map((v) => v ?? null);
  }

  function rateRow(
    overrides: Partial<Record<string, ExcelJS.CellValue>> = {},
  ): ExcelJS.CellValue[] {
    const row: Record<string, ExcelJS.CellValue> = {
      branch: 'DXB',
      origin: 'AEJEA',
      destination: 'SDPZU',
      mode: 'SEA',
      load: 'FCL',
      cargo: 'CONTAINER',
      container: '40HC',
      unit: 'PER_CONTAINER',
      price: '1250.50',
      currency: 'USD',
      from: day,
      to: null,
      ...overrides,
    };
    return [
      row.branch,
      row.origin,
      row.destination,
      row.mode,
      row.load,
      row.cargo,
      row.container,
      row.unit,
      row.price,
      row.currency,
      row.from,
      row.to,
    ].map((v) => v ?? null);
  }

  /** Responses of `requests`, sent while `hold` keeps a lock they all wait for. */
  async function whileLocked(
    hold: (tx: Parameters<Parameters<typeof t.prisma.$transaction>[0]>[0]) => Promise<void>,
    requests: (() => ReturnType<typeof upload>)[],
  ) {
    const { pending } = await t.prisma.$transaction(
      async (tx) => {
        await hold(tx);
        const sent = requests.map((request) => request().then((res) => res));
        await waitForLockWaiter(t.prisma, requests.length);
        return { pending: Promise.all(sent) };
      },
      { timeout: 20_000 },
    );
    return pending;
  }

  /**
   * Responses of `first` and `second`, queued in that order on the lock `hold` keeps: once it is
   * released, PostgreSQL grants it to them in the order they asked, so `first` writes first.
   */
  async function oneAfterTheOther(
    hold: (tx: Parameters<Parameters<typeof t.prisma.$transaction>[0]>[0]) => Promise<void>,
    first: () => ReturnType<typeof upload>,
    second: () => ReturnType<typeof upload>,
  ) {
    const { pending } = await t.prisma.$transaction(
      async (tx) => {
        await hold(tx);
        const one = first().then((res) => res);
        await waitForLockWaiter(t.prisma, 1);
        const two = second().then((res) => res);
        await waitForLockWaiter(t.prisma, 2);
        return { pending: Promise.all([one, two]) };
      },
      { timeout: 20_000 },
    );
    return pending;
  }

  const post = (path: string, cookie: string, body: object) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  const locationId = async (code: string) =>
    (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;

  /** The body of POST /rates for the offer rateRow() writes with the same overrides. */
  async function rateBody(from: string) {
    return {
      branchId: dxb,
      originLocationId: await locationId('AEJEA'),
      destinationLocationId: await locationId('SDPZU'),
      mode: 'SEA',
      loadType: 'FCL',
      cargoType: 'CONTAINER',
      containerTypeCode: '40HC',
      unit: 'PER_CONTAINER',
      price: '999',
      currency: 'USD',
      validFrom: from,
    };
  }

  function codesOf(preview: ImportPreviewDto): [number, string | null, string][] {
    return preview.issues.map((i) => [i.row, i.column, i.code]);
  }

  beforeAll(async () => {
    t = await createTestApp();
    dxb = await branchId(t.prisma, 'DXB');
    const zziFields = {
      nameEn: 'Import test',
      nameAr: 'اختبار الاستيراد',
      countryCode: 'AE',
      city: 'Test',
      defaultCurrency: 'USD',
      timezone: 'Asia/Dubai',
      isActive: true,
    };
    zzi = (
      await t.prisma.branch.upsert({
        where: { code: 'ZZI' },
        create: { code: 'ZZI', ...zziFields },
        update: zziFields,
      })
    ).id;
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR']),
      salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
      salesJed: await createUser(t.prisma, ['SALES'], ['JED']),
      opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
      managerDxb: await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB']),
      salesZzi: await createUser(t.prisma, ['SALES'], ['ZZI']),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
  });

  afterAll(async () => {
    await t.prisma.branch.update({ where: { id: zzi }, data: { isActive: true } });
    await deleteCommercialTestData(t.prisma);
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  describe('templates', () => {
    it('downloads the customer template with the user’s branches and active currencies', async () => {
      const res = await t
        .http()
        .get('/api/v1/customers/import/template?locale=en')
        .set('Cookie', cookies.salesDxb)
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (c: Buffer) => chunks.push(c));
          response.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as Parameters<ExcelJS.Xlsx['load']>[0]);
      const [data, , lists] = wb.worksheets;
      expect(data?.getCell('A1').value).toBe('Branch code *');
      const listed: string[] = [];
      lists?.eachRow((row, n) => {
        if (n > 1) listed.push(row.getCell(1).text);
      });
      expect(listed.filter((c) => c !== '')).toEqual(['DXB']);
      expect(lists?.getCell('C2').text).toMatch(/^[A-Z]{3}$/);
    });

    it('downloads the rate template in Arabic', async () => {
      const res = await t
        .http()
        .get('/api/v1/rates/import/template?locale=ar')
        .set('Cookie', cookies.salesDxb)
        .expect(200);
      expect(res.headers['content-disposition']).toContain('nolon-rates-template-ar.xlsx');
    });

    it('needs the create permission', async () => {
      await t
        .http()
        .get('/api/v1/customers/import/template')
        .set('Cookie', cookies.opsDxb)
        .expect(403);
      await t
        .http()
        .get('/api/v1/rates/import/template')
        .set('Cookie', cookies.managerDxb)
        .expect(403);
      await t.http().get('/api/v1/rates/import/template').expect(401);
    });
  });

  describe('customers', () => {
    it('previews a valid file and writes nothing', async () => {
      const before = await myCustomers();
      const file = await xlsx([
        CUSTOMER_HEADER,
        customerRow(),
        customerRow({ kind: 'individual', limit: 1500.75 }),
      ]);
      const preview = (
        await upload('/customers/import/preview', cookies.salesDxb, file).expect(200)
      ).body as ImportPreviewDto;
      expect(preview).toMatchObject({ kind: 'customers', totalRows: 2, validRows: 2, issues: [] });
      expect(preview.rows[1]?.values).toMatchObject({ kind: 'INDIVIDUAL', creditLimit: '1500.75' });
      expect(await myCustomers()).toBe(before);
    });

    it('reports each bad row and column: branch, currency, amount, duplicates', async () => {
      const existing = phone();
      await t
        .http()
        .post('/api/v1/customers')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookies.salesDxb)
        .send({
          branchId: dxb,
          kind: 'COMPANY',
          name: 'Already here',
          phone: existing,
          taxNumber: `TX-${existing}`,
        })
        .expect(201);
      const twice = phone();
      const file = await xlsx([
        CUSTOMER_HEADER,
        customerRow({ branch: 'JED' }),
        customerRow({ currency: 'XYZ' }),
        customerRow({ limit: '12.34567' }),
        customerRow({ limit: '1,000' }),
        customerRow({ limitCurrency: null }),
        customerRow({ phone: twice }),
        customerRow({ phone: twice }),
        customerRow({ phone: existing }),
        customerRow({ tax: `tx-${existing}` }),
        customerRow({ name: null, phone: '0912345678' }),
        customerRow({ kind: 'PARTNER', terms: 400 }),
        // A schema error does not hide the rule errors of the same row: both show at once.
        customerRow({ kind: 'PARTNER', currency: 'XYZ' }),
      ]);
      const preview = (
        await upload('/customers/import/preview', cookies.salesDxb, file).expect(200)
      ).body as ImportPreviewDto;
      expect(preview.totalRows).toBe(12);
      expect(preview.validRows).toBe(1);
      expect(codesOf(preview)).toEqual([
        [2, 'branchCode', 'BRANCH_NOT_ALLOWED'],
        [3, 'preferredCurrency', 'UNKNOWN_CURRENCY'],
        [4, 'creditLimit', 'AMOUNT_NOT_EXACT'],
        [5, 'creditLimit', 'INVALID_AMOUNT'],
        [6, 'creditLimitCurrency', 'CREDIT_LIMIT_PAIR'],
        [8, 'phone', 'DUPLICATE_IN_FILE'],
        [9, 'phone', 'DUPLICATE_IN_DB'],
        [10, 'taxNumber', 'DUPLICATE_IN_DB'],
        [11, 'name', 'REQUIRED'],
        [11, 'phone', 'INVALID_FORMAT'],
        [12, 'kind', 'INVALID_VALUE'],
        [12, 'paymentTermsDays', 'INVALID_VALUE'],
        [13, 'kind', 'INVALID_VALUE'],
        [13, 'preferredCurrency', 'UNKNOWN_CURRENCY'],
      ]);
      expect(preview.issues.find((i) => i.row === 8)?.otherRow).toBe(7);
    });

    it('commits nothing when any row fails', async () => {
      const before = await myCustomers();
      const file = await xlsx([
        CUSTOMER_HEADER,
        customerRow(),
        customerRow(),
        customerRow({ currency: 'XYZ' }),
      ]);
      const res = await commit('/customers/import', cookies.salesDxb, file, randomUUID()).expect(
        422,
      );
      const body = res.body as ImportRowsInvalidBody;
      expect(body.code).toBe('ROWS_INVALID');
      expect(body.preview.validRows).toBe(2);
      expect(await myCustomers()).toBe(before);
    });

    it('imports every row in one go, and a retry with the same request id writes nothing more', async () => {
      const before = await myCustomers();
      const requestId = randomUUID();
      const phones = [phone(), phone(), phone()];
      const file = await xlsx([
        CUSTOMER_HEADER,
        customerRow({ phone: phones[0] }),
        customerRow({ phone: phones[1], limit: 99999999999999.5 }),
        customerRow({ phone: phones[2], limit: null, limitCurrency: null, terms: null }),
      ]);
      const first = (
        await commit('/customers/import', cookies.salesDxb, file, requestId).expect(201)
      ).body as ImportResultDto;
      expect(first).toMatchObject({ kind: 'customers', requestId, created: 3, replayed: false });
      expect(await myCustomers()).toBe(before + 3);

      const saved = await t.prisma.customer.findMany({
        where: { id: { in: first.ids } },
        orderBy: { number: 'asc' },
      });
      expect(saved.map((c) => c.phone)).toEqual(phones);
      expect(saved.every((c) => c.branchId === dxb && /^NOL-CUS-\d{6}$/.test(c.number))).toBe(true);
      expect(new Set(saved.map((c) => c.number)).size).toBe(3);
      expect(saved[0]?.creditLimit?.toFixed()).toBe('5000.25');
      expect(saved[1]?.creditLimit?.toFixed()).toBe('99999999999999.5');
      expect(saved[2]).toMatchObject({ creditLimit: null, paymentTermsDays: 0 });

      const again = (
        await commit('/customers/import', cookies.salesDxb, file, requestId).expect(201)
      ).body as ImportResultDto;
      expect(again).toMatchObject({ created: 3, replayed: true, ids: first.ids });
      expect(await myCustomers()).toBe(before + 3);

      // Another branch's user cannot reuse (or read through) that request id.
      await commit('/customers/import', cookies.salesJed, file, requestId).expect(409);
      // And the same file under a new request id is now all duplicates.
      const dup = (
        await commit('/customers/import', cookies.salesDxb, file, randomUUID()).expect(422)
      ).body as ImportRowsInvalidBody;
      expect(dup.preview.issues.map((i) => i.code)).toEqual([
        'DUPLICATE_IN_DB',
        'DUPLICATE_IN_DB',
        'DUPLICATE_IN_DB',
      ]);
    });

    it('commits nothing when a row names a branch the user does not hold', async () => {
      const before = await myCustomers();
      const file = await xlsx([CUSTOMER_HEADER, customerRow(), customerRow({ branch: 'JED' })]);
      const body = (
        await commit('/customers/import', cookies.salesDxb, file, randomUUID()).expect(422)
      ).body as ImportRowsInvalidBody;
      expect(codesOf(body.preview)).toEqual([[3, 'branchCode', 'BRANCH_NOT_ALLOWED']]);
      expect(await myCustomers()).toBe(before);
    });

    it('replays only an exact retry: another file, user or kind under the request id is a 409', async () => {
      const requestId = randomUUID();
      const file = await xlsx([CUSTOMER_HEADER, customerRow()]);
      const first = (
        await commit('/customers/import', cookies.salesDxb, file, requestId).expect(201)
      ).body as ImportResultDto;
      const [customers, rates] = [await myCustomers(), await myRates()];

      const again = (
        await commit('/customers/import', cookies.salesDxb, file, requestId).expect(201)
      ).body as ImportResultDto;
      expect(again).toMatchObject({ replayed: true, created: 1, ids: first.ids });
      // Another file from the same user.
      const otherFile = await xlsx([CUSTOMER_HEADER, customerRow()]);
      await commit('/customers/import', cookies.salesDxb, otherFile, requestId).expect(409);
      // The same file from another user who may write to the branch.
      await commit('/customers/import', cookies.admin, file, requestId).expect(409);
      // Another kind of import.
      const rateFile = await xlsx([
        RATE_HEADER,
        rateRow({ container: 'OTHER', unit: 'PER_PIECE' }),
      ]);
      await commit('/rates/import', cookies.salesDxb, rateFile, requestId).expect(409);
      expect([await myCustomers(), await myRates()]).toEqual([customers, rates]);

      // And the other way round: a rates request id is not a customers one.
      const ratesRequest = randomUUID();
      await commit('/rates/import', cookies.salesDxb, rateFile, ratesRequest).expect(201);
      await commit('/customers/import', cookies.salesDxb, otherFile, ratesRequest).expect(409);
      expect(await myCustomers()).toBe(customers);
    });

    it('two concurrent commits of one request write once; the other replays', async () => {
      const before = await myCustomers();
      const requestId = randomUUID();
      const file = await xlsx([CUSTOMER_HEADER, customerRow(), customerRow()]);
      const send = () => commit('/customers/import', cookies.salesDxb, file, requestId);
      const responses = await whileLocked((tx) => lockImportRequest(tx, requestId), [send, send]);
      expect(responses.map((r) => r.status)).toEqual([201, 201]);
      const results = responses.map((r) => r.body as ImportResultDto);
      expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
      expect(results[0]?.ids).toEqual(results[1]?.ids);
      expect(await myCustomers()).toBe(before + 2);
    });

    it('two concurrent imports with the same phone in one branch: one succeeds, one is a 422', async () => {
      const shared = phone();
      const one = await xlsx([CUSTOMER_HEADER, customerRow({ phone: shared })]);
      const two = await xlsx([CUSTOMER_HEADER, customerRow(), customerRow({ phone: shared })]);
      const responses = await whileLocked(
        (tx) => lockBranchRule(tx, CUSTOMER_UNIQUE_RULE, [dxb]),
        [
          () => commit('/customers/import', cookies.salesDxb, one, randomUUID()),
          () => commit('/customers/import', cookies.salesDxb, two, randomUUID()),
        ],
      );
      expect(responses.map((r) => r.status).sort()).toEqual([201, 422]);
      const refused = responses.find((r) => r.status === 422)?.body as ImportRowsInvalidBody;
      expect(refused.code).toBe('ROWS_INVALID');
      expect(refused.preview.issues.map((i) => [i.column, i.code])).toEqual([
        ['phone', 'DUPLICATE_IN_DB'],
      ]);
      expect(await t.prisma.customer.count({ where: { branchId: dxb, phone: shared } })).toBe(1);
    });

    it('takes a full file of IMPORT_MAX_ROWS rows in one transaction, and refuses one more', async () => {
      const before = await myCustomers();
      const rows = Array.from({ length: IMPORT_MAX_ROWS }, (_, i) =>
        customerRow({ phone: `+2497${String(10_000_000 + i)}${String(randomInt(10, 99))}` }),
      );
      const full = await xlsx([CUSTOMER_HEADER, ...rows]);
      const started = Date.now();
      const result = (
        await commit('/customers/import', cookies.salesDxb, full, randomUUID()).expect(201)
      ).body as ImportResultDto;
      expect(result.created).toBe(IMPORT_MAX_ROWS);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(await myCustomers()).toBe(before + IMPORT_MAX_ROWS);
      const over = await xlsx([CUSTOMER_HEADER, ...rows, customerRow()]);
      const res = await upload('/customers/import/preview', cookies.salesDxb, over).expect(400);
      expect((res.body as ImportFileErrorBody).code).toBe('TOO_MANY_ROWS');
    }, 60_000);

    it('needs customers:create and a request id', async () => {
      const file = await xlsx([CUSTOMER_HEADER, customerRow()]);
      await upload('/customers/import/preview', cookies.opsDxb, file).expect(403);
      await commit('/customers/import', cookies.opsDxb, file, randomUUID()).expect(403);
      await upload('/customers/import', cookies.salesDxb, file).expect(400);
      await commit('/customers/import', cookies.salesDxb, file, 'not-a-uuid').expect(400);
    });

    it('refuses files that are not small .xlsx workbooks with the template’s columns', async () => {
      const good = await xlsx([CUSTOMER_HEADER, customerRow()]);
      const codeOf = async (req: ReturnType<typeof upload>, status: number) =>
        ((await req.expect(status)).body as ImportFileErrorBody).code;
      expect(
        await codeOf(upload('/customers/import/preview', cookies.salesDxb, good, 'c.csv'), 400),
      ).toBe('NOT_XLSX');
      expect(
        await codeOf(
          upload(
            '/customers/import/preview',
            cookies.salesDxb,
            Buffer.from('name,phone\n'),
            'c.xlsx',
          ),
          400,
        ),
      ).toBe('UNREADABLE');
      const oversize = Buffer.concat([good, Buffer.alloc(IMPORT_MAX_BYTES + 1 - good.length)]);
      expect(
        await codeOf(upload('/customers/import/preview', cookies.salesDxb, oversize), 413),
      ).toBe('FILE_TOO_LARGE');
      await upload(
        '/customers/import/preview',
        cookies.salesDxb,
        Buffer.alloc(IMPORT_MAX_BYTES + 100),
      ).expect(413);
      expect(
        await codeOf(
          upload('/customers/import/preview', cookies.salesDxb, await xlsx([['Name'], ['x']])),
          400,
        ),
      ).toBe('MISSING_COLUMNS');
      expect(
        await codeOf(
          upload('/customers/import/preview', cookies.salesDxb, await xlsx([CUSTOMER_HEADER])),
          400,
        ),
      ).toBe('NO_ROWS');
      expect(
        await codeOf(upload('/customers/import/preview', cookies.salesDxb, Buffer.alloc(0)), 400),
      ).toBe('UNREADABLE');
      // A zip whose entry declares 100 bytes and inflates to 1 GiB.
      expect(
        await codeOf(
          upload('/customers/import/preview', cookies.salesDxb, lyingZipBomb(1024)),
          400,
        ),
      ).toBe('UNREADABLE');
    });
  });

  describe('rates', () => {
    it('reports the rate rules, wrong branch and duplicates per row', async () => {
      await t
        .http()
        .post('/api/v1/rates')
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookies.salesDxb)
        .send({
          branchId: dxb,
          originLocationId: (
            await t.prisma.location.findUniqueOrThrow({ where: { code: 'AEJEA' } })
          ).id,
          destinationLocationId: (
            await t.prisma.location.findUniqueOrThrow({ where: { code: 'SDPZU' } })
          ).id,
          mode: 'ROAD',
          cargoType: 'GENERAL',
          unit: 'PER_KG',
          price: '2',
          currency: 'USD',
          validFrom: day,
        })
        .expect(201);
      const file = await xlsx([
        RATE_HEADER,
        rateRow(),
        rateRow({ branch: 'JED' }),
        rateRow({ origin: 'ZZNOPE' }),
        rateRow({ destination: 'AEJEA' }),
        rateRow({ mode: 'ROAD' }),
        rateRow({ container: null }),
        rateRow({ cargo: 'GENERAL' }),
        rateRow({ currency: 'XYZ' }),
        rateRow({ price: '10.12345' }),
        rateRow({ price: 'ten' }),
        rateRow({ to: '2020-01-01' }),
        rateRow(),
        rateRow({
          mode: 'ROAD',
          load: null,
          cargo: 'GENERAL',
          container: null,
          unit: 'PER_KG',
          price: '2',
        }),
        rateRow({ from: '31/12/2031' }),
        // A schema error does not hide the rule errors of the same row: all show at once.
        rateRow({ mode: 'AIR', price: 'ten', currency: 'XYZ', to: '2020-01-01' }),
      ]);
      const preview = (await upload('/rates/import/preview', cookies.salesDxb, file).expect(200))
        .body as ImportPreviewDto;
      expect(codesOf(preview)).toEqual([
        [3, 'branchCode', 'BRANCH_NOT_ALLOWED'],
        [4, 'originCode', 'UNKNOWN_LOCATION'],
        [5, 'destinationCode', 'SAME_ROUTE'],
        [6, 'loadType', 'LOAD_TYPE_SEA_ONLY'],
        [7, 'containerType', 'CONTAINER_TYPE_REQUIRED'],
        [8, 'containerType', 'CONTAINER_TYPE_NOT_APPLICABLE'],
        [9, 'currency', 'UNKNOWN_CURRENCY'],
        [10, 'price', 'AMOUNT_NOT_EXACT'],
        [11, 'price', 'INVALID_AMOUNT'],
        [12, 'validTo', 'VALID_TO_BEFORE_FROM'],
        // Same offer as row 2: a duplicate even while it has other errors.
        [12, 'validFrom', 'DUPLICATE_IN_FILE'],
        [13, 'validFrom', 'DUPLICATE_IN_FILE'],
        [14, 'validFrom', 'DUPLICATE_IN_DB'],
        [15, 'validFrom', 'INVALID_DATE'],
        [16, 'price', 'INVALID_AMOUNT'],
        [16, 'mode', 'INVALID_VALUE'],
        [16, 'currency', 'UNKNOWN_CURRENCY'],
        [16, 'validTo', 'VALID_TO_BEFORE_FROM'],
      ]);
      expect(preview.validRows).toBe(1);
    });

    it('imports draft rates with exact prices, once per request id', async () => {
      const before = await myRates();
      const requestId = randomUUID();
      const file = await xlsx([
        RATE_HEADER,
        rateRow({ container: '20GP', price: '1250.5000' }),
        rateRow({
          container: '40GP',
          price: 99.95,
          from: new Date(`${day}T00:00:00Z`),
          to: '2032-12-31',
        }),
      ]);
      await commit('/rates/import', cookies.managerDxb, file, requestId).expect(403);
      const first = (await commit('/rates/import', cookies.salesDxb, file, requestId).expect(201))
        .body as ImportResultDto;
      expect(first).toMatchObject({ kind: 'rates', created: 2, replayed: false });
      const saved = await t.prisma.rateCard.findMany({
        where: { id: { in: first.ids } },
        orderBy: { price: 'desc' },
      });
      expect(
        saved.map((r) => [r.status, r.containerTypeCode, r.price.toFixed(), r.branchId]),
      ).toEqual([
        ['DRAFT', '20GP', '1250.5', dxb],
        ['DRAFT', '40GP', '99.95', dxb],
      ]);
      expect(saved[1]?.validTo?.toISOString().slice(0, 10)).toBe('2032-12-31');
      const again = (await commit('/rates/import', cookies.salesDxb, file, requestId).expect(201))
        .body as ImportResultDto;
      expect(again).toMatchObject({ replayed: true, ids: first.ids });
      expect(await myRates()).toBe(before + 2);
    });

    it('commits nothing when a row names a branch the user does not hold', async () => {
      const before = await myRates();
      const file = await xlsx([RATE_HEADER, rateRow(), rateRow({ branch: 'JED' })]);
      const body = (await commit('/rates/import', cookies.salesDxb, file, randomUUID()).expect(422))
        .body as ImportRowsInvalidBody;
      expect(codesOf(body.preview)).toEqual([[3, 'branchCode', 'BRANCH_NOT_ALLOWED']]);
      expect(await myRates()).toBe(before);
    });

    it('writes nothing when one row of many fails', async () => {
      const before = await myRates();
      const file = await xlsx([
        RATE_HEADER,
        rateRow({ container: 'OTHER', unit: 'PER_CBM' }),
        rateRow({ container: 'OTHER', unit: 'PER_PIECE', currency: 'XYZ' }),
      ]);
      await commit('/rates/import', cookies.salesDxb, file, randomUUID()).expect(422);
      expect(await myRates()).toBe(before);
    });
  });

  describe('one duplicate rule for every write path', () => {
    const refusedCodes = (res: { body: unknown }) =>
      (res.body as ImportRowsInvalidBody).preview.issues.map((i) => [i.column, i.code]);

    it('refuses a single create or edit that repeats a phone or tax number of the branch (409)', async () => {
      const taken = phone();
      const first = (
        await post('/customers', cookies.salesDxb, {
          branchId: dxb,
          kind: 'COMPANY',
          name: 'Unique keys',
          phone: taken,
          taxNumber: `TX-${taken}`,
        }).expect(201)
      ).body as { id: string };
      const body = { branchId: dxb, kind: 'COMPANY', name: 'Second' };
      await post('/customers', cookies.salesDxb, { ...body, phone: taken }).expect(409);
      await post('/customers', cookies.salesDxb, {
        ...body,
        phone: phone(),
        taxNumber: ` tx-${taken.toLowerCase()} `,
      }).expect(409);
      // Another branch may hold the same phone and tax number.
      await post('/customers', cookies.admin, {
        ...body,
        branchId: await branchId(t.prisma, 'JED'),
        phone: taken,
        taxNumber: `TX-${taken}`,
      }).expect(201);
      const other = (
        await post('/customers', cookies.salesDxb, { ...body, phone: phone() }).expect(201)
      ).body as { id: string };
      const edit = (id: string, change: object) =>
        t
          .http()
          .patch(`/api/v1/customers/${id}`)
          .set('Origin', APP_ORIGIN)
          .set('Cookie', cookies.salesDxb)
          .send(change);
      await edit(other.id, { phone: taken }).expect(409);
      await edit(other.id, { taxNumber: `tx-${taken}` }).expect(409);
      // Saving a customer's own phone and tax number again is no duplicate.
      await edit(first.id, { phone: taken, taxNumber: `tx-${taken}`, name: 'Renamed' }).expect(200);
      expect(await t.prisma.customer.count({ where: { branchId: dxb, phone: taken } })).toBe(1);
    });

    it('refuses a single create or edit that repeats a draft or approved rate (409)', async () => {
      const from = day.replace('2031', '2035');
      const draft = (await post('/rates', cookies.salesDxb, await rateBody(from)).expect(201))
        .body as { id: string };
      await post('/rates', cookies.salesDxb, await rateBody(from)).expect(409);
      const other = (
        await post('/rates', cookies.salesDxb, {
          ...(await rateBody(from)),
          containerTypeCode: '20GP',
        }).expect(201)
      ).body as { id: string };
      const edit = (id: string, change: object) =>
        t
          .http()
          .patch(`/api/v1/rates/${id}`)
          .set('Origin', APP_ORIGIN)
          .set('Cookie', cookies.salesDxb)
          .send(change);
      await edit(other.id, { containerTypeCode: '40HC' }).expect(409);
      await edit(draft.id, { price: '1000' }).expect(200);
      // A cancelled rate no longer holds the offer.
      await t
        .http()
        .post(`/api/v1/rates/${draft.id}/cancel`)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookies.admin)
        .expect(200);
      await edit(other.id, { containerTypeCode: '40HC' }).expect(200);
    });

    describe('a stale edit cannot take back a key another record took meanwhile', () => {
      type Tx = Parameters<Parameters<typeof t.prisma.$transaction>[0]>[0];
      const patch = (path: string, change: object) =>
        t
          .http()
          .patch(`/api/v1${path}`)
          .set('Origin', APP_ORIGIN)
          .set('Cookie', cookies.salesDxb)
          .send(change);
      const newCustomer = async (fields: object = {}) =>
        (
          await post('/customers', cookies.salesDxb, {
            branchId: dxb,
            kind: 'COMPANY',
            name: 'Stale edit',
            phone: phone(),
            ...fields,
          }).expect(201)
        ).body as { id: string; phone: string };

      // whileLocked: the uncommitted transaction moves the record off its key and gives that key
      // to another record; the stale edit (which read the record before) then waits on the row.
      it('phone', async () => {
        const old = phone();
        const a = await newCustomer({ phone: old });
        const b = await newCustomer();
        const [res] = await whileLocked(
          async (tx: Tx) => {
            await tx.customer.update({ where: { id: a.id }, data: { phone: phone() } });
            await tx.customer.update({ where: { id: b.id }, data: { phone: old } });
          },
          [() => patch(`/customers/${a.id}`, { name: 'Stale form', phone: old })],
        );
        expect(res?.status).toBe(409);
        expect(await t.prisma.customer.count({ where: { branchId: dxb, phone: old } })).toBe(1);
      });

      it('tax number', async () => {
        const old = `TX-${phone()}`;
        const a = await newCustomer({ taxNumber: old });
        const b = await newCustomer();
        const [res] = await whileLocked(
          async (tx: Tx) => {
            await tx.customer.update({ where: { id: a.id }, data: { taxNumber: `TX-${phone()}` } });
            await tx.customer.update({ where: { id: b.id }, data: { taxNumber: old } });
          },
          [
            () =>
              patch(`/customers/${a.id}`, {
                name: 'Stale form',
                phone: a.phone,
                taxNumber: old.toLowerCase(),
              }),
          ],
        );
        expect(res?.status).toBe(409);
        expect(
          await t.prisma.customer.count({
            where: { branchId: dxb, taxNumber: { equals: old, mode: 'insensitive' } },
          }),
        ).toBe(1);
      });

      it('rate offer', async () => {
        const from = day.replace('2031', '2036');
        const later = day.replace('2031', '2037');
        const body = await rateBody(from);
        const a = (await post('/rates', cookies.salesDxb, body).expect(201)).body as { id: string };
        const b = (
          await post('/rates', cookies.salesDxb, { ...body, containerTypeCode: '20GP' }).expect(201)
        ).body as { id: string };
        const [res] = await whileLocked(
          async (tx: Tx) => {
            await tx.rateCard.update({
              where: { id: a.id },
              data: { validFrom: new Date(`${later}T00:00:00Z`) },
            });
            await tx.rateCard.update({ where: { id: b.id }, data: { containerTypeCode: '40HC' } });
          },
          [() => patch(`/rates/${a.id}`, { ...body, branchId: undefined, price: '1100' })],
        );
        expect(res?.status).toBe(409);
        expect(
          await t.prisma.rateCard.count({
            where: {
              branchId: dxb,
              containerTypeCode: '40HC',
              validFrom: new Date(`${from}T00:00:00Z`),
              status: { in: ['DRAFT', 'APPROVED'] },
            },
          }),
        ).toBe(1);
      });
    });

    for (const order of ['import first', 'create first'] as const) {
      it(`import and a single create race on one phone (${order}): one writes, the other is refused`, async () => {
        const shared = phone();
        const file = await xlsx([CUSTOMER_HEADER, customerRow({ phone: shared })]);
        const importing = () => commit('/customers/import', cookies.salesDxb, file, randomUUID());
        const creating = () =>
          post('/customers', cookies.salesDxb, {
            branchId: dxb,
            kind: 'COMPANY',
            name: 'Raced',
            phone: shared,
          });
        const hold = (tx: Parameters<Parameters<typeof t.prisma.$transaction>[0]>[0]) =>
          lockBranchRule(tx, CUSTOMER_UNIQUE_RULE, [dxb]);
        if (order === 'import first') {
          const [imported, created] = await oneAfterTheOther(hold, importing, creating);
          expect([imported.status, created.status]).toEqual([201, 409]);
        } else {
          const [created, imported] = await oneAfterTheOther(hold, creating, importing);
          expect([created.status, imported.status]).toEqual([201, 422]);
          expect(refusedCodes(imported)).toEqual([['phone', 'DUPLICATE_IN_DB']]);
        }
        expect(await t.prisma.customer.count({ where: { branchId: dxb, phone: shared } })).toBe(1);
      });

      it(`import and a single create race on one tax number (${order}): one writes, the other is refused`, async () => {
        const tax = `TX-${phone()}`;
        const file = await xlsx([CUSTOMER_HEADER, customerRow({ tax })]);
        const importing = () => commit('/customers/import', cookies.salesDxb, file, randomUUID());
        const creating = () =>
          post('/customers', cookies.salesDxb, {
            branchId: dxb,
            kind: 'COMPANY',
            name: 'Raced',
            phone: phone(),
            taxNumber: tax.toLowerCase(),
          });
        const hold = (tx: Parameters<Parameters<typeof t.prisma.$transaction>[0]>[0]) =>
          lockBranchRule(tx, CUSTOMER_UNIQUE_RULE, [dxb]);
        if (order === 'import first') {
          const [imported, created] = await oneAfterTheOther(hold, importing, creating);
          expect([imported.status, created.status]).toEqual([201, 409]);
        } else {
          const [created, imported] = await oneAfterTheOther(hold, creating, importing);
          expect([created.status, imported.status]).toEqual([201, 422]);
          expect(refusedCodes(imported)).toEqual([['taxNumber', 'DUPLICATE_IN_DB']]);
        }
        expect(
          await t.prisma.customer.count({
            where: { branchId: dxb, taxNumber: { equals: tax, mode: 'insensitive' } },
          }),
        ).toBe(1);
      });

      it(`import and a single create race on one rate (${order}): one writes, the other is refused`, async () => {
        const from = day.replace('2031', order === 'import first' ? '2033' : '2034');
        const file = await xlsx([RATE_HEADER, rateRow({ from })]);
        const body = await rateBody(from);
        const importing = () => commit('/rates/import', cookies.salesDxb, file, randomUUID());
        const creating = () => post('/rates', cookies.salesDxb, body);
        const hold = (tx: Parameters<Parameters<typeof t.prisma.$transaction>[0]>[0]) =>
          lockBranchRule(tx, RATE_UNIQUE_RULE, [dxb]);
        if (order === 'import first') {
          const [imported, created] = await oneAfterTheOther(hold, importing, creating);
          expect([imported.status, created.status]).toEqual([201, 409]);
        } else {
          const [created, imported] = await oneAfterTheOther(hold, creating, importing);
          expect([created.status, imported.status]).toEqual([201, 422]);
          expect(refusedCodes(imported)).toEqual([['validFrom', 'DUPLICATE_IN_DB']]);
        }
        expect(
          await t.prisma.rateCard.count({
            where: {
              branchId: dxb,
              containerTypeCode: '40HC',
              validFrom: new Date(`${from}T00:00:00Z`),
              status: { in: ['DRAFT', 'APPROVED'] },
            },
          }),
        ).toBe(1);
      });
    }
  });

  describe('branch deactivated during a commit', () => {
    const deactivate = (tx: Parameters<Parameters<typeof t.prisma.$transaction>[0]>[0]) =>
      tx.branch.update({ where: { id: zzi }, data: { isActive: false } });
    const reactivate = () =>
      t.prisma.branch.update({ where: { id: zzi }, data: { isActive: true } });
    const zziCustomers = () => t.prisma.customer.count({ where: { branchId: zzi } });

    it('a deactivation committed first refuses the import waiting on the branch (422)', async () => {
      const before = await zziCustomers();
      const file = await xlsx([CUSTOMER_HEADER, customerRow({ branch: 'ZZI' })]);
      try {
        const { pending } = await t.prisma.$transaction(
          async (tx) => {
            await deactivate(tx);
            // The import passed its first checks (the deactivation is not committed yet) and
            // waits on the branch row inside its transaction.
            const sent = commit('/customers/import', cookies.salesZzi, file, randomUUID()).then(
              (res) => res,
            );
            await waitForLockWaiter(t.prisma, 1);
            return { pending: sent };
          },
          { timeout: 20_000 },
        );
        const res = await pending;
        expect(res.status).toBe(422);
        expect(
          (res.body as ImportRowsInvalidBody).preview.issues.map((i) => [i.column, i.code]),
        ).toEqual([['branchCode', 'BRANCH_NOT_ALLOWED']]);
        expect(await zziCustomers()).toBe(before);
      } finally {
        await reactivate();
      }
    });

    it('the same holds for rates', async () => {
      const before = await t.prisma.rateCard.count({ where: { branchId: zzi } });
      const file = await xlsx([RATE_HEADER, rateRow({ branch: 'ZZI' })]);
      try {
        const { pending } = await t.prisma.$transaction(
          async (tx) => {
            await deactivate(tx);
            const sent = commit('/rates/import', cookies.salesZzi, file, randomUUID()).then(
              (res) => res,
            );
            await waitForLockWaiter(t.prisma, 1);
            return { pending: sent };
          },
          { timeout: 20_000 },
        );
        const res = await pending;
        expect(res.status).toBe(422);
        expect(
          (res.body as ImportRowsInvalidBody).preview.issues.map((i) => [i.column, i.code]),
        ).toEqual([['branchCode', 'BRANCH_NOT_ALLOWED']]);
        expect(await t.prisma.rateCard.count({ where: { branchId: zzi } })).toBe(before);
      } finally {
        await reactivate();
      }
    });

    it('an import that holds the branch first commits, and the deactivation waits for it', async () => {
      const before = await zziCustomers();
      const file = await xlsx([
        CUSTOMER_HEADER,
        customerRow({ branch: 'ZZI' }),
        customerRow({ branch: 'ZZI' }),
      ]);
      try {
        let deactivated: Promise<unknown> = Promise.resolve();
        const { pending } = await t.prisma.$transaction(
          async (tx) => {
            // Barrier: the import locks the branch row, then waits on the customer rule lock.
            await lockBranchRule(tx, CUSTOMER_UNIQUE_RULE, [zzi]);
            const sent = commit('/customers/import', cookies.salesZzi, file, randomUUID()).then(
              (res) => res,
            );
            await waitForLockWaiter(t.prisma, 1);
            deactivated = t.prisma.$transaction((other) => deactivate(other)).then((b) => b);
            // The deactivation waits on the branch row the import holds.
            await waitForLockWaiter(t.prisma, 2);
            return { pending: sent };
          },
          { timeout: 20_000 },
        );
        const res = await pending;
        expect(res.status).toBe(201);
        await deactivated;
        expect(await zziCustomers()).toBe(before + 2);
        expect((await t.prisma.branch.findUniqueOrThrow({ where: { id: zzi } })).isActive).toBe(
          false,
        );
      } finally {
        await reactivate();
      }
    });
  });
});
