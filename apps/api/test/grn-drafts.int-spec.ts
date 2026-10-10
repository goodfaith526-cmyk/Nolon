import { createHash, randomBytes, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import type {
  AgentAuthorizeResponse,
  AgentClientCreatedDto,
  AgentTokenResponse,
  BookingDto,
  CustomerDto,
  GrnDraftDto,
  GrnDraftSummaryDto,
  PackingListContentDto,
  ShipmentDocumentDto,
  SheetPreviewDto,
  ShipmentDto,
  WarehouseDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packStoredZip } from '../src/common/zip-guard.js';
import {
  APP_ORIGIN,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import { deleteCommercialTestData, uniquePhone, waitForLockWaiter } from './test-data.js';

// Draft GRNs from packing lists (Document Pilot). Users acting through the assistant keep the
// agent-it- prefix: agent_access_events is append-only and references them, so they are never
// deleted. Bookings and customers are created by it- users, so the usual cleanup removes the
// shipments, their documents, drafts and movements.
const AGENT_PREFIX = 'agent-it-';
const REDIRECT = 'https://agent.test/auth/nolon/callback';
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

let t: TestApp;
let client: AgentClientCreatedDto;
let otherClient: AgentClientCreatedDto;
let customer: CustomerDto;
let warehouse: WarehouseDto;
let jebelAli: string;
let portSudan: string;

const cookies = {
  admin: '',
  opsDxb: '',
  salesDxb: '',
  whDxb: '',
  whDxb2: '',
  whJed: '',
  opsAgent: '',
};
const tokens = { whDxb: '', whDxb2: '', whJed: '', opsAgent: '', whDxbOther: '' };

const get = (path: string, cookie: string) => t.http().get(`/api/v1${path}`).set('Cookie', cookie);
const post = (path: string, cookie: string, body: object = {}) =>
  t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
const patch = (path: string, cookie: string, body: object) =>
  t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
const del = (path: string, cookie: string) =>
  t.http().delete(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie);
const agentGet = (path: string, token: string) =>
  t.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
const agentSend = (method: 'post' | 'patch', path: string, token: string, body: object = {}) =>
  t.http()[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

async function registerClient(name: string): Promise<AgentClientCreatedDto> {
  const res = await post('/agent-clients', cookies.admin, {
    name,
    redirectUri: REDIRECT,
    audience: 'erp-agents',
    tenant: 'nolon-test',
  }).expect(201);
  return res.body as AgentClientCreatedDto;
}

/** The delegated sign-in (PKCE) a staff member makes from the assistant; its token. */
async function tokenFor(cookie: string, c: AgentClientCreatedDto = client): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorized = await post('/agent-auth/authorize', cookie, {
    clientId: c.client.clientId,
    redirectUri: REDIRECT,
    state: 'state-1234',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
  }).expect(200);
  const code = new URL((authorized.body as AgentAuthorizeResponse).redirectTo).searchParams.get(
    'code',
  );
  const res = await t
    .http()
    .post('/api/v1/agent-auth/token')
    .send({
      clientId: c.client.clientId,
      clientSecret: c.clientSecret,
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
    })
    .expect(200);
  return (res.body as AgentTokenResponse).accessToken;
}

async function confirmedShipment(): Promise<ShipmentDto> {
  const booking = (
    await post('/bookings', cookies.opsDxb, {
      customerId: customer.id,
      originLocationId: jebelAli,
      destinationLocationId: portSudan,
      mode: 'SEA',
      loadType: 'FCL',
      cargoType: 'GENERAL',
      services: ['MAIN_FREIGHT'],
      items: [{ cargoType: 'GENERAL', quantity: 10, weightKg: '1000' }],
    }).expect(201)
  ).body as BookingDto;
  const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.opsDxb).expect(200))
    .body as BookingDto;
  return (await get(`/shipments/${confirmed.shipmentId}`, cookies.opsDxb).expect(200))
    .body as ShipmentDto;
}

function upload(
  shipmentId: string,
  data: Buffer,
  typeCode = 'PACKING_LIST',
  fileName = 'packing list.pdf',
) {
  return t
    .http()
    .post(`/api/v1/shipments/${shipmentId}/documents`)
    .set('Origin', APP_ORIGIN)
    .set('Cookie', cookies.whDxb)
    .field('typeCode', typeCode)
    .field('fileName', fileName)
    .attach('file', data, 'upload.bin');
}

async function packingList(shipmentId: string, data: Buffer = PDF): Promise<ShipmentDocumentDto> {
  return (await upload(shipmentId, data).expect(201)).body as ShipmentDocumentDto;
}

/** What the assistant sends for a document: two lines read from it. */
function draftBody(document: { id: string }, data: Buffer = PDF, extra: object = {}) {
  return {
    idempotencyKey: `turn-${randomUUID()}`,
    documentId: document.id,
    documentSha256: sha256(data),
    statedTotals: { packages: 10, grossKg: '1000.000' },
    warnings: [],
    lines: [
      {
        marks: 'NOL/1-6',
        description: 'Cotton shirts',
        packageCount: 6,
        packageType: 'CARTON',
        grossKg: '600.5',
        sourcePage: 1,
        match: { marks: 'MATCHED', description: 'MATCHED', packageCount: 'MATCHED' },
      },
      { description: 'Trousers', packageCount: 4, grossKg: '399.5', sourcePage: 1 },
    ],
    ...extra,
  };
}

const createDraft = (shipmentId: string, body: object, token = tokens.whDxb) =>
  agentSend('post', `/shipments/${shipmentId}/grn-drafts`, token, body);

async function accessLog(token: string) {
  const row = await t.prisma.agentToken.findUniqueOrThrow({
    where: { tokenHash: sha256(Buffer.from(token)) },
  });
  const rows = await t.prisma.agentAccessEvent.findMany({
    where: { agentTokenId: row.id },
    orderBy: { id: 'asc' },
  });
  return rows.map((r) => [r.method, r.route, r.allowed]);
}

const receipt = (version: number, extra: object = {}) => ({
  version,
  warehouseId: warehouse.id,
  packages: 10,
  weightKg: '1000',
  condition: 'GOOD',
  ...extra,
});

const movementCount = (shipmentId: string) =>
  t.prisma.warehouseMovement.count({ where: { shipmentId } });

beforeAll(async () => {
  t = await createTestApp();
  const dxb = await branchId(t.prisma, 'DXB');
  const loc = async (code: string) =>
    (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
  jebelAli = await loc('AEJEA');
  portSudan = await loc('SDPZU');
  const users = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX),
    opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
    salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
    whDxb: await createUser(t.prisma, ['WAREHOUSE'], ['DXB'], AGENT_PREFIX),
    whDxb2: await createUser(t.prisma, ['WAREHOUSE'], ['DXB'], AGENT_PREFIX),
    whJed: await createUser(t.prisma, ['WAREHOUSE'], ['JED'], AGENT_PREFIX),
    opsAgent: await createUser(t.prisma, ['OPERATIONS'], ['DXB'], AGENT_PREFIX),
  };
  for (const key of Object.keys(users) as (keyof typeof users)[]) {
    cookies[key] = await signIn(t, users[key].email);
  }
  client = await registerClient('GRN draft platform');
  otherClient = await registerClient('GRN draft other platform');
  tokens.whDxb = await tokenFor(cookies.whDxb);
  tokens.whDxb2 = await tokenFor(cookies.whDxb2);
  tokens.whJed = await tokenFor(cookies.whJed);
  tokens.opsAgent = await tokenFor(cookies.opsAgent);
  tokens.whDxbOther = await tokenFor(cookies.whDxb, otherClient);

  const created = (
    await post('/customers', cookies.salesDxb, {
      branchId: dxb,
      kind: 'COMPANY',
      name: 'GRN Draft Test Trading',
      phone: uniquePhone(),
    }).expect(201)
  ).body as CustomerDto;
  customer = (await get(`/customers/${created.id}`, cookies.salesDxb).expect(200))
    .body as CustomerDto;
  warehouse = (
    await post('/warehouses', cookies.whDxb, {
      branchId: dxb,
      code: 'zz-grn-1',
      nameEn: 'Draft test store',
      nameAr: 'مستودع اختبار المسودات',
    }).expect(201)
  ).body as WarehouseDto;
});

afterAll(async () => {
  await deleteCommercialTestData(t.prisma);
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('packing list files', () => {
  it('accepts an .xlsx packing list, and .xlsx for no other document type', async () => {
    const s = await confirmedShipment();
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Packing list').addRow(['Marks', 'Description', 'Cartons']);
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
    const doc = (await upload(s.id, xlsx, 'PACKING_LIST', 'list.xlsx').expect(201))
      .body as ShipmentDocumentDto;
    expect(doc.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    await upload(s.id, xlsx, 'COMMERCIAL_INVOICE', 'invoice.xlsx').expect(400);
  });

  it('refuses a macro-enabled workbook and an archive that is not a workbook', async () => {
    const s = await confirmedShipment();
    const entry = (name: string) => ({
      name: Buffer.from(name),
      utf8Name: true,
      content: Buffer.from('<x/>'),
    });
    const xlsm = packStoredZip([
      entry('[Content_Types].xml'),
      entry('xl/workbook.xml'),
      entry('xl/vbaProject.bin'),
    ]);
    await upload(s.id, xlsm, 'PACKING_LIST', 'list.xlsx').expect(400);
    const docx = packStoredZip([entry('[Content_Types].xml'), entry('word/document.xml')]);
    await upload(s.id, docx, 'PACKING_LIST', 'list.xlsx').expect(400);
  });

  it('the assistant reads a packing list as JSON, without its name; no other document', async () => {
    const s = await confirmedShipment();
    const doc = await packingList(s.id);
    const res = await agentGet(
      `/shipments/${s.id}/documents/${doc.id}/packing-list-content`,
      tokens.whDxb,
    ).expect(200);
    const body = res.body as PackingListContentDto;
    expect(Buffer.from(body.dataBase64, 'base64').equals(PDF)).toBe(true);
    expect(body).toMatchObject({ contentType: 'application/pdf', sha256: sha256(PDF) });
    expect(JSON.stringify(body)).not.toContain('packing list.pdf');
    const photo = (await upload(s.id, PDF, 'BL', 'bl.pdf').expect(201)).body as ShipmentDocumentDto;
    await agentGet(
      `/shipments/${s.id}/documents/${photo.id}/packing-list-content`,
      tokens.whDxb,
    ).expect(404);
    await agentGet(
      `/shipments/${s.id}/documents/${doc.id}/packing-list-content`,
      tokens.whJed,
    ).expect(404);
  });
  it('the review screen shows a PDF inline and an .xlsx as cells; other branches and the assistant get nothing', async () => {
    const s = await confirmedShipment();
    const pdf = await packingList(s.id);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('PL');
    sheet.addRow(['Marks', 'Cartons', 'Total']);
    sheet.addRow(['NOL/1', 6, { formula: 'B2*2', result: 12 }]);
    const data = Buffer.from(await workbook.xlsx.writeBuffer());
    const xlsx = (await upload(s.id, data, 'PACKING_LIST', 'list.xlsx').expect(201))
      .body as ShipmentDocumentDto;
    const base = `/shipments/${s.id}/documents`;

    const inline = await get(`${base}/${pdf.id}/preview`, cookies.whDxb).expect(200);
    expect(inline.headers['content-type']).toBe('application/pdf');
    expect(inline.headers['content-disposition']).toBe('inline');
    expect(inline.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    expect(inline.headers['x-content-type-options']).toBe('nosniff');
    await get(`${base}/${xlsx.id}/preview`, cookies.whDxb).expect(404);

    const cells = (await get(`${base}/${xlsx.id}/sheet`, cookies.whDxb).expect(200))
      .body as SheetPreviewDto;
    expect(cells).toEqual({
      sheetName: 'PL',
      truncated: false,
      rows: [
        { rowNumber: 1, cells: ['Marks', 'Cartons', 'Total'] },
        { rowNumber: 2, cells: ['NOL/1', '6', '12'] },
      ],
    });
    await get(`${base}/${pdf.id}/sheet`, cookies.whDxb).expect(404);

    for (const id of [pdf.id, xlsx.id]) {
      await get(`${base}/${id}/preview`, cookies.whJed).expect(404);
      await get(`${base}/${id}/sheet`, cookies.whJed).expect(404);
      await agentGet(`${base}/${id}/preview`, tokens.whDxb).expect(403);
      await agentGet(`${base}/${id}/sheet`, tokens.whDxb).expect(403);
    }
  });
});

describe('the assistant creates a draft', () => {
  it('creates a draft whose AI-filled values are marked, and gets no document text back', async () => {
    const s = await confirmedShipment();
    const doc = await packingList(s.id);
    const res = await createDraft(s.id, draftBody(doc)).expect(201);
    const summary = res.body as GrnDraftSummaryDto;
    expect(summary).toMatchObject({
      status: 'DRAFT',
      version: 1,
      lineCount: 2,
      lineTotals: { packages: 10, grossKg: '1000', netKg: null, cbm: null },
    });
    expect(JSON.stringify(summary)).not.toMatch(/Cotton|Trousers|NOL\/1-6/);

    const draft = (
      await get(`/shipments/${s.id}/grn-drafts/${summary.id}`, cookies.whDxb).expect(200)
    ).body as GrnDraftDto;
    expect(draft.lines[0]?.fields).toEqual({
      marks: { filledBy: 'AI', match: 'MATCHED' },
      description: { filledBy: 'AI', match: 'MATCHED' },
      packageCount: { filledBy: 'AI', match: 'MATCHED' },
      packageType: { filledBy: 'AI', match: 'UNVERIFIED' },
      grossKg: { filledBy: 'AI', match: 'UNVERIFIED' },
    });
    expect(draft.statedTotals).toEqual({ packages: 10, grossKg: '1000', netKg: null, cbm: null });
    expect(draft.actions).toEqual({ canEdit: true, canDecide: true });
    // The shipment and its warehouse are untouched until a person approves.
    expect(await movementCount(s.id)).toBe(0);
    expect(await accessLog(tokens.whDxb)).toContainEqual([
      'POST',
      '/api/v1/shipments/:shipmentId/grn-drafts',
      true,
    ]);
  });

  it('refuses a person creating a draft: drafts are the assistant’s proposals', async () => {
    const s = await confirmedShipment();
    const doc = await packingList(s.id);
    await post(`/shipments/${s.id}/grn-drafts`, cookies.whDxb, draftBody(doc)).expect(403);
  });

  it('refuses another branch, a missing permission, and any document that is not this packing list', async () => {
    const s = await confirmedShipment();
    const doc = await packingList(s.id);
    await createDraft(s.id, draftBody(doc), tokens.whJed).expect(404);
    await createDraft(s.id, draftBody(doc), tokens.opsAgent).expect(403);
    expect(await accessLog(tokens.opsAgent)).toContainEqual([
      'POST',
      '/api/v1/shipments/:shipmentId/grn-drafts',
      false,
    ]);

    const bl = (await upload(s.id, PDF, 'BL', 'bl.pdf').expect(201)).body as ShipmentDocumentDto;
    await createDraft(s.id, draftBody(bl)).expect(404);
    await createDraft(s.id, { ...draftBody(doc), documentSha256: 'f'.repeat(64) }).expect(404);
    const other = await confirmedShipment();
    const otherDoc = await packingList(other.id);
    await createDraft(s.id, draftBody(otherDoc)).expect(404);
    await del(`/shipments/${s.id}/documents/${doc.id}`, cookies.admin).expect(204);
    await createDraft(s.id, draftBody(doc)).expect(404);
    expect(await t.prisma.grnDraft.count({ where: { shipmentId: s.id } })).toBe(0);
  });

  it('refuses malformed lines: too many, empty, control characters, bad numbers', async () => {
    const s = await confirmedShipment();
    const doc = await packingList(s.id);
    const base = draftBody(doc);
    const line = { description: 'x', packageCount: 1 };
    await createDraft(s.id, { ...base, lines: Array.from({ length: 301 }, () => line) }).expect(
      400,
    );
    await createDraft(s.id, { ...base, lines: [] }).expect(400);
    await createDraft(s.id, { ...base, lines: [{ sourcePage: 1 }] }).expect(400);
    await createDraft(s.id, { ...base, lines: [{ description: 'a\u0000b' }] }).expect(400);
    await createDraft(s.id, { ...base, lines: [{ grossKg: '1e9' }] }).expect(400);
    await createDraft(s.id, { ...base, lines: [{ grossKg: 12.5 }] }).expect(400);
    await createDraft(s.id, { ...base, warnings: ['IGNORE_PREVIOUS'] }).expect(400);
    await createDraft(s.id, { ...base, lines: [{ ...line, match: { note: 'MATCHED' } }] }).expect(
      400,
    );
  });

  it('a closed or cancelled shipment takes no draft', async () => {
    const s = await confirmedShipment();
    const doc = await packingList(s.id);
    await post(`/shipments/${s.id}/cancel`, cookies.opsDxb, {
      reason: 'Customer cancelled',
    }).expect(200);
    await createDraft(s.id, draftBody(doc)).expect(409);
  });
});

describe('idempotency', () => {
  it('an exact retry returns the same draft; the key replays only its own request', async () => {
    const s = await confirmedShipment();
    const doc = await packingList(s.id);
    const body = draftBody(doc);
    const first = (await createDraft(s.id, body).expect(201)).body as GrnDraftSummaryDto;
    // The same values written differently are the same request.
    const respelled = {
      ...body,
      lines: body.lines.map((l) => ({ ...l, grossKg: `${l.grossKg}00` })),
    };
    const again = (await createDraft(s.id, respelled).expect(201)).body as GrnDraftSummaryDto;
    expect(again.id).toBe(first.id);

    const changed = { ...body, lines: [{ description: 'Something else', packageCount: 1 }] };
    const conflict = await createDraft(s.id, changed).expect(409);
    expect(JSON.stringify(conflict.body)).not.toContain(first.id);

    // The same bytes uploaded to another shipment are another document.
    const other = await confirmedShipment();
    const otherDoc = await packingList(other.id);
    const elsewhere = await createDraft(other.id, {
      ...draftBody(otherDoc),
      idempotencyKey: body.idempotencyKey,
    }).expect(409);
    expect(JSON.stringify(elsewhere.body)).not.toContain(first.id);
    const secondDoc = await packingList(s.id);
    await createDraft(s.id, { ...body, documentId: secondDoc.id }).expect(409);
    expect(await t.prisma.grnDraft.count({ where: { shipmentId: { in: [s.id, other.id] } } })).toBe(
      1,
    );
  });

  it('two creates at once with one key make one draft', async () => {
    const s = await confirmedShipment();
    const doc = await packingList(s.id);
    const body = draftBody(doc);
    const [a, b] = await Promise.all([createDraft(s.id, body), createDraft(s.id, body)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((a.body as GrnDraftSummaryDto).id).toBe((b.body as GrnDraftSummaryDto).id);
    expect(await t.prisma.grnDraft.count({ where: { shipmentId: s.id } })).toBe(1);
  });

  it('another user or another assistant client is another scope, never the first draft', async () => {
    const s = await confirmedShipment();
    const doc = await packingList(s.id);
    const body = draftBody(doc);
    const mine = (await createDraft(s.id, body).expect(201)).body as GrnDraftSummaryDto;
    const theirs = (await createDraft(s.id, body, tokens.whDxb2).expect(201))
      .body as GrnDraftSummaryDto;
    const otherApp = (await createDraft(s.id, body, tokens.whDxbOther).expect(201))
      .body as GrnDraftSummaryDto;
    expect(new Set([mine.id, theirs.id, otherApp.id]).size).toBe(3);

    const byKey = (token: string) =>
      agentGet(`/shipments/${s.id}/grn-drafts/by-key/${body.idempotencyKey}`, token);
    expect(((await byKey(tokens.whDxb).expect(200)).body as GrnDraftSummaryDto).id).toBe(mine.id);
    expect(((await byKey(tokens.whDxb2).expect(200)).body as GrnDraftSummaryDto).id).toBe(
      theirs.id,
    );
    await byKey(tokens.whJed).expect(404);
    await byKey(tokens.opsAgent).expect(403);
    // A person's session cannot use the assistant's recovery route.
    await get(`/shipments/${s.id}/grn-drafts/by-key/${body.idempotencyKey}`, cookies.whDxb).expect(
      403,
    );
  });

  it('recovery by key is refused once the source packing list is gone', async () => {
    const s = await confirmedShipment();
    const doc = await packingList(s.id);
    const body = draftBody(doc);
    await createDraft(s.id, body).expect(201);
    await del(`/shipments/${s.id}/documents/${doc.id}`, cookies.admin).expect(204);
    await agentGet(
      `/shipments/${s.id}/grn-drafts/by-key/${body.idempotencyKey}`,
      tokens.whDxb,
    ).expect(404);
  });
});

describe('a person reviews the draft', () => {
  async function draftOn(): Promise<{
    s: ShipmentDto;
    draft: GrnDraftSummaryDto;
    doc: ShipmentDocumentDto;
  }> {
    const s = await confirmedShipment();
    const doc = await packingList(s.id);
    const draft = (await createDraft(s.id, draftBody(doc)).expect(201)).body as GrnDraftSummaryDto;
    return { s, draft, doc };
  }

  it('the assistant cannot read, edit, approve or reject drafts', async () => {
    const { s, draft } = await draftOn();
    const base = `/shipments/${s.id}/grn-drafts`;
    await agentGet(base, tokens.whDxb).expect(403);
    await agentGet(`${base}/${draft.id}`, tokens.whDxb).expect(403);
    await agentSend('patch', `${base}/${draft.id}`, tokens.whDxb, { version: 1, lines: [] }).expect(
      403,
    );
    await agentSend('post', `${base}/${draft.id}/approve`, tokens.whDxb, receipt(1)).expect(403);
    await agentSend('post', `${base}/${draft.id}/reject`, tokens.whDxb, {
      version: 1,
      reason: 'x',
    }).expect(403);
    // Nor any other write, e.g. the receipt itself.
    await agentSend('post', `/shipments/${s.id}/warehouse/receipts`, tokens.whDxb, {
      warehouseId: warehouse.id,
      packages: 1,
      condition: 'GOOD',
    }).expect(403);
    const log = await accessLog(tokens.whDxb);
    expect(log).toContainEqual([
      'POST',
      '/api/v1/shipments/:shipmentId/grn-drafts/:draftId/approve',
      false,
    ]);
    expect(await movementCount(s.id)).toBe(0);
  });

  it('edits keep what was left as it was and mark what the person changed', async () => {
    const { s, draft } = await draftOn();
    const path = `/shipments/${s.id}/grn-drafts/${draft.id}`;
    const edited = (
      await patch(path, cookies.whDxb, {
        version: 1,
        lines: [
          {
            lineNo: 1,
            marks: 'NOL/1-6',
            description: 'Cotton shirts',
            packageCount: 5,
            packageType: 'CARTON',
            grossKg: '600.500',
          },
          { description: 'Belts', packageCount: 1 },
        ],
      }).expect(200)
    ).body as GrnDraftDto;
    expect(edited.version).toBe(2);
    expect(edited.lines[0]?.fields).toMatchObject({
      marks: { filledBy: 'AI', match: 'MATCHED' },
      packageCount: { filledBy: 'STAFF', match: null },
      grossKg: { filledBy: 'AI', match: 'UNVERIFIED' },
    });
    expect(edited.lines[1]?.fields).toEqual({
      description: { filledBy: 'STAFF', match: null },
      packageCount: { filledBy: 'STAFF', match: null },
    });
    expect(edited.lineTotals.packages).toBe(6);
    // Stale version: someone changed it meanwhile.
    await patch(path, cookies.whDxb, { version: 1, lines: [{ description: 'x' }] }).expect(409);
    // Read-only users see drafts but cannot change them.
    await get(path, cookies.salesDxb).expect(200);
    await patch(path, cookies.salesDxb, { version: 2, lines: [{ description: 'x' }] }).expect(403);
    await get(path, cookies.whJed).expect(404);
  });

  it('approval records exactly one GRN through the receipt path; a second approval returns it', async () => {
    const { s, draft } = await draftOn();
    const path = `/shipments/${s.id}/grn-drafts/${draft.id}`;
    const approved = (await post(`${path}/approve`, cookies.whDxb, receipt(1)).expect(201))
      .body as GrnDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', version: 2 });
    expect(approved.movementNumber).toMatch(/^NOL-GRN-\d{4}-\d{6}$/);
    expect(approved.actions).toEqual({ canEdit: false, canDecide: false });
    const again = (await post(`${path}/approve`, cookies.whDxb, receipt(2)).expect(201))
      .body as GrnDraftDto;
    expect(again.movementId).toBe(approved.movementId);
    expect(await movementCount(s.id)).toBe(1);
    const movement = await t.prisma.warehouseMovement.findUniqueOrThrow({
      where: { id: approved.movementId ?? '' },
    });
    expect(movement).toMatchObject({ kind: 'RECEIPT', packages: 10, condition: 'GOOD' });
    await patch(path, cookies.whDxb, { version: 2, lines: [{ description: 'x' }] }).expect(409);
    await post(`${path}/reject`, cookies.whDxb, { version: 2, reason: 'late' }).expect(409);
  });

  it('two approvals at once record one GRN', async () => {
    const { s, draft } = await draftOn();
    const path = `/shipments/${s.id}/grn-drafts/${draft.id}/approve`;
    const pending = await t.prisma.$transaction(
      async (tx) => {
        // Hold the shipment row, so both approvals queue on it.
        await tx.$queryRaw`SELECT 1 FROM "shipments" WHERE "id" = ${s.id}::uuid FOR UPDATE`;
        const a = Promise.resolve(post(path, cookies.whDxb, receipt(1)));
        const b = Promise.resolve(post(path, cookies.whDxb, receipt(1)));
        await waitForLockWaiter(t.prisma, 2);
        return [a, b];
      },
      { timeout: 15_000 },
    );
    const [a, b] = await Promise.all(pending);
    expect([a?.status, b?.status]).toEqual([201, 201]);
    expect((a?.body as GrnDraftDto).movementId).toBe((b?.body as GrnDraftDto).movementId);
    expect(await movementCount(s.id)).toBe(1);
  });

  it('a failure after the GRN is written and before the draft is finalised rolls back both', async () => {
    const { s, draft } = await draftOn();
    const fn = `grn_fault_${draft.id.replace(/-/g, '')}`;
    await t.prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${fn}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" = '${draft.id}'::uuid AND NEW."state" = 'APPROVED' THEN
          RAISE EXCEPTION 'injected fault';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await t.prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${fn}" BEFORE UPDATE ON "grn_drafts" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`,
    );
    try {
      await post(
        `/shipments/${s.id}/grn-drafts/${draft.id}/approve`,
        cookies.whDxb,
        receipt(1),
      ).expect(500);
    } finally {
      await t.prisma.$executeRawUnsafe(`DROP TRIGGER "${fn}" ON "grn_drafts"`);
      await t.prisma.$executeRawUnsafe(`DROP FUNCTION "${fn}"()`);
    }
    expect(await movementCount(s.id)).toBe(0);
    const row = await t.prisma.grnDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row).toMatchObject({ state: 'DRAFT', version: 1, movementId: null });
    // Nothing is half done: the approval now goes through once.
    await post(
      `/shipments/${s.id}/grn-drafts/${draft.id}/approve`,
      cookies.whDxb,
      receipt(1),
    ).expect(201);
    expect(await movementCount(s.id)).toBe(1);
  });

  it('a packing list being deleted makes approval and creation wait, then refuse', async () => {
    const { s, draft, doc } = await draftOn();
    const pending = await t.prisma.$transaction(
      async (tx) => {
        // A removal in progress, not yet committed: it holds the document row.
        await tx.$executeRaw`UPDATE "documents" SET "deleted_at" = now(), "deleted_by_id" = "uploaded_by_id" WHERE "id" = ${doc.id}::uuid`;
        const approve = Promise.resolve(
          post(`/shipments/${s.id}/grn-drafts/${draft.id}/approve`, cookies.whDxb, receipt(1)),
        );
        const create = Promise.resolve(createDraft(s.id, draftBody(doc)));
        await waitForLockWaiter(t.prisma, 2);
        return [approve, create];
      },
      { timeout: 15_000 },
    );
    const [approve, create] = await Promise.all(pending);
    expect(approve?.status).toBe(409);
    expect(create?.status).toBe(404);
    expect(await movementCount(s.id)).toBe(0);
    const row = await t.prisma.grnDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row).toMatchObject({ state: 'DRAFT', version: 1 });
  });

  it('a delete that comes while an approval is under way waits until the GRN is recorded', async () => {
    const { s, draft, doc } = await draftOn();
    // Pauses the approval inside its transaction, after the packing list check, at the GRN
    // insert, until the test lets go of an advisory lock.
    const fn = `grn_pause_${draft.id.replace(/-/g, '')}`;
    await t.prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${fn}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."shipment_id" = '${s.id}'::uuid THEN
          PERFORM pg_advisory_xact_lock(hashtext('${fn}'));
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await t.prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${fn}" BEFORE INSERT ON "warehouse_movements" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`,
    );
    try {
      const pending = await t.prisma.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtext('${fn}'))`);
          const approve = Promise.resolve(
            post(`/shipments/${s.id}/grn-drafts/${draft.id}/approve`, cookies.whDxb, receipt(1)),
          );
          await waitForLockWaiter(t.prisma, 1);
          const remove = Promise.resolve(
            del(`/shipments/${s.id}/documents/${doc.id}`, cookies.admin),
          );
          await waitForLockWaiter(t.prisma, 2);
          return [approve, remove];
        },
        { timeout: 15_000 },
      );
      const [approve, remove] = await Promise.all(pending);
      expect(approve?.status).toBe(201);
      expect(remove?.status).toBe(204);
    } finally {
      await t.prisma.$executeRawUnsafe(`DROP TRIGGER "${fn}" ON "warehouse_movements"`);
      await t.prisma.$executeRawUnsafe(`DROP FUNCTION "${fn}"()`);
    }
    expect(await movementCount(s.id)).toBe(1);
    const row = await t.prisma.grnDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.state).toBe('APPROVED');
    const document = await t.prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(document.deletedAt).not.toBeNull();
  });

  it('total warnings follow the lines: an edit opens or closes them, the assistant cannot', async () => {
    const s = await confirmedShipment();
    const doc = await packingList(s.id);
    const created = (
      await createDraft(
        s.id,
        draftBody(doc, PDF, { warnings: ['TOTAL_GROSS_MISMATCH', 'SOURCE_NOT_VERIFIABLE'] }),
      ).expect(201)
    ).body as GrnDraftSummaryDto;
    // The lines add up to the stated 10 packages and 1000 kg: only the note about the file stays.
    expect(created.warnings).toEqual(['SOURCE_NOT_VERIFIABLE']);
    const path = `/shipments/${s.id}/grn-drafts/${created.id}`;
    const line = (packageCount: number, grossKg: string) => ({ packageCount, grossKg });
    const opened = (
      await patch(path, cookies.whDxb, {
        version: 1,
        lines: [line(6, '600.5'), { ...line(3, '399.5'), netKg: '400' }],
      }).expect(200)
    ).body as GrnDraftDto;
    expect(opened.warnings).toEqual([
      'TOTAL_PACKAGES_MISMATCH',
      'SOURCE_NOT_VERIFIABLE',
      'NET_ABOVE_GROSS',
    ]);
    const list = (await get(`/shipments/${s.id}/grn-drafts`, cookies.whDxb).expect(200))
      .body as GrnDraftSummaryDto[];
    expect(list[0]?.warnings).toEqual(opened.warnings);
    const closed = (
      await patch(path, cookies.whDxb, {
        version: 2,
        lines: [line(6, '600.50'), line(4, '399.5')],
      }).expect(200)
    ).body as GrnDraftDto;
    expect(closed.warnings).toEqual(['SOURCE_NOT_VERIFIABLE']);
  });

  it('an expired draft, a stale version, a deleted source or another branch cannot be approved', async () => {
    const stale = await draftOn();
    await post(
      `/shipments/${stale.s.id}/grn-drafts/${stale.draft.id}/approve`,
      cookies.whDxb,
      receipt(2),
    ).expect(409);

    const gone = await draftOn();
    await del(`/shipments/${gone.s.id}/documents/${gone.doc.id}`, cookies.admin).expect(204);
    await post(
      `/shipments/${gone.s.id}/grn-drafts/${gone.draft.id}/approve`,
      cookies.whDxb,
      receipt(1),
    ).expect(409);

    const jed = await draftOn();
    await post(
      `/shipments/${jed.s.id}/grn-drafts/${jed.draft.id}/approve`,
      cookies.whJed,
      receipt(1),
    ).expect(404);

    const expired = await draftOn();
    await t.prisma.grnDraft.update({
      where: { id: expired.draft.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const path = `/shipments/${expired.s.id}/grn-drafts/${expired.draft.id}`;
    expect(((await get(path, cookies.whDxb).expect(200)).body as GrnDraftDto).status).toBe(
      'EXPIRED',
    );
    await post(`${path}/approve`, cookies.whDxb, receipt(1)).expect(409);
    await patch(path, cookies.whDxb, { version: 1, lines: [{ description: 'x' }] }).expect(409);

    for (const { s } of [stale, gone, jed, expired]) expect(await movementCount(s.id)).toBe(0);
  });

  it('rejection closes the draft for good, enforced by the database too', async () => {
    const { s, draft } = await draftOn();
    const path = `/shipments/${s.id}/grn-drafts/${draft.id}`;
    const rejected = (
      await post(`${path}/reject`, cookies.whDxb, { version: 1, reason: 'Wrong file' }).expect(201)
    ).body as GrnDraftDto;
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectReason: 'Wrong file' });
    await post(`${path}/approve`, cookies.whDxb, receipt(2)).expect(409);
    await expect(
      t.prisma.grnDraft.update({ where: { id: draft.id }, data: { rejectReason: 'changed' } }),
    ).rejects.toThrow(/decided/);
    await expect(
      t.prisma.grnDraftLine.updateMany({
        where: { draftId: draft.id },
        data: { description: 'x' },
      }),
    ).rejects.toThrow(/decided/);
  });
});
