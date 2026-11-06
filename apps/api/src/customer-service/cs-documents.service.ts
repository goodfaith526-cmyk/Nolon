import { createHash, randomBytes } from 'node:crypto';
import { GoneException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CsRequestDocumentsDto } from '@nolon/shared';
import QRCode from 'qrcode';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { fromDbDate } from '../common/dates.js';
import { dec, toDecimalString, toDecimalStringOrNull } from '../common/money.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PdfService, PdfUnavailableError } from '../pdf/pdf.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ApiClientAuth } from './api-client.guard.js';
import type { BookingRequestCaller } from './booking-request.guard.js';
import { provenOwnerOf, servedBy } from './request-owner.js';
import { type DocumentLang, receiptHtml, waybillHtml } from './document-html.js';

type Db = PrismaService | Prisma.TransactionClient;
type Proof = { channel: 'whatsapp' | 'telegram' | 'web'; subjectId: string } | null;

/** How long a document link lasts (plan 09 section 7). */
export const DOCUMENT_LINK_MS = 10 * 60_000;
const ROUTE = 'GET /cs/documents/:token';

const liveReceipts = { kind: 'RECEIPT', cancellation: null } as const;

const hashOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

function notFound(): HttpException {
  return new HttpException(
    { message: 'Document not found', code: 'DOCUMENT_NOT_FOUND', statusCode: 404 },
    HttpStatus.NOT_FOUND,
  );
}

/**
 * Plan 13-5 (owner, 2026-11-06): the customer hands over two things at the window, the parcel and
 * the fees, and gets one document for each: the waybill for the parcel (once received) and a
 * receipt for each payment. The request's read gives its proven owner short-lived links; the
 * download checks everything again (key, owner, branches, the document still valid) and renders
 * the PDF then. Nothing is stored; every download is in the access log.
 */
@Injectable()
export class CsDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfs: PdfService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  private base(): string | null {
    const base = this.env.PUBLIC_WEB_URL ?? this.env.CORS_ORIGINS[0];
    return base ? base.replace(/\/+$/, '') : null;
  }

  /**
   * Fresh links for an approved request's shipment, to its proven owner (the caller checks that):
   * null while the switch is off or NOLON's public address is unknown.
   */
  async linksFor(
    client: ApiClientAuth,
    requestId: string,
    shipmentId: string,
  ): Promise<CsRequestDocumentsDto | null> {
    const base = this.base();
    if (!this.env.CS_DOCUMENTS_ENABLED || base === null) return null;
    const ready = await waybillReady(this.prisma, shipmentId);
    const receipts = await shipmentReceipts(this.prisma, shipmentId, client.allowedBranchIds);
    const expiresAt = new Date(Date.now() + DOCUMENT_LINK_MS);
    const issued: { token: string; receiptId: string | null }[] = [
      ...(ready ? [{ token: randomBytes(32).toString('base64url'), receiptId: null }] : []),
      ...receipts.map((r) => ({ token: randomBytes(32).toString('base64url'), receiptId: r.id })),
    ];
    if (issued.length > 0) {
      await this.prisma.csDocumentLink.createMany({
        data: issued.map((i) => ({
          tokenHash: hashOf(i.token),
          apiClientId: client.id,
          requestId,
          kind: i.receiptId === null ? 'WAYBILL' : 'RECEIPT',
          receiptId: i.receiptId,
          expiresAt,
        })),
      });
    }
    const link = (token: string) => ({
      url: `${base}/api/v1/cs/documents/${token}`,
      expiresAt: expiresAt.toISOString(),
    });
    const tokenOf = (receiptId: string | null) =>
      issued.find((i) => i.receiptId === receiptId)!.token;
    return {
      waybill: ready ? link(tokenOf(null)) : null,
      receipts: receipts.map((r) => ({
        ...link(tokenOf(r.id)),
        number: r.number,
        receiptDate: fromDbDate(r.receiptDate),
        amount: toDecimalString(r.amount),
        currency: r.currency,
      })),
    };
  }

  /**
   * The document behind a link, rendered now. 404 for anything not (or no longer) the caller's:
   * another key, another owner, a branch the key no longer serves, a waybill whose goods receipt
   * was cancelled, a cancelled receipt. 410 once the link expired. 403 OWNER_PROOF_REQUIRED for
   * the key alone.
   */
  async download(
    caller: BookingRequestCaller,
    token: string,
    proof: Proof,
  ): Promise<{ bytes: Buffer; filename: string }> {
    const outcome = async (code: string) => this.record(caller, proof, code);
    if (!this.env.CS_DOCUMENTS_ENABLED || !/^[A-Za-z0-9_-]{16,200}$/.test(token)) {
      await outcome('NOT_FOUND');
      throw notFound();
    }
    const owner = provenOwnerOf(caller, proof, 'Downloading a document');
    const link = await this.prisma.csDocumentLink.findUnique({
      where: { tokenHash: hashOf(token) },
    });
    if (!link || link.apiClientId !== caller.client.id) {
      await outcome('NOT_FOUND');
      throw notFound();
    }
    if (link.expiresAt.getTime() <= Date.now()) {
      await outcome('EXPIRED');
      throw new GoneException({ message: 'The link expired', code: 'DOCUMENT_EXPIRED' });
    }
    const request = await this.prisma.csBookingRequest.findFirst({
      where: { AND: [owner, { id: link.requestId, status: 'APPROVED' }] },
      select: {
        branchId: true,
        allowedBranchIds: true,
        language: true,
        booking: { select: { status: true, shipment: { select: { id: true } } } },
      },
    });
    const shipmentId = request?.booking?.shipment?.id;
    if (
      !request ||
      !servedBy(request, caller.client.allowedBranchIds) ||
      request.booking?.status === 'CANCELLED' ||
      !shipmentId
    ) {
      await outcome('NOT_FOUND');
      throw notFound();
    }
    const lang: DocumentLang = request.language === 'en' ? 'en' : 'ar';
    let html: string;
    let filename: string;
    if (link.kind === 'WAYBILL') {
      const data = await this.waybill(shipmentId);
      if (!data) {
        await outcome('NOT_FOUND');
        throw notFound();
      }
      html = waybillHtml(data, lang);
      filename = `waybill-${data.number}.pdf`;
    } else {
      const data = await this.receipt(shipmentId, link.receiptId!, caller.client.allowedBranchIds);
      if (!data) {
        await outcome('NOT_FOUND');
        throw notFound();
      }
      html = receiptHtml(data, lang);
      filename = `receipt-${data.number}.pdf`;
    }
    let bytes: Buffer;
    try {
      bytes = await this.pdfs.render(html);
    } catch (error) {
      if (!(error instanceof PdfUnavailableError)) throw error;
      const code = error.reason === 'NOT_CONFIGURED' ? 'PDF_UNAVAILABLE' : 'PDF_FAILED';
      await outcome(code);
      throw new HttpException(
        { message: 'The document cannot be made now', code, statusCode: 503 },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    await outcome('OK');
    return { bytes, filename: filename.replace(/[^A-Za-z0-9.-]/g, '') };
  }

  /** The waybill's facts, or null when the shipment has none (not received, or cancelled). */
  private async waybill(shipmentId: string) {
    if (!(await waybillReady(this.prisma, shipmentId))) return null;
    const s = await this.prisma.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: {
        number: true,
        mode: true,
        services: true,
        trackingToken: true,
        origin: { select: { nameAr: true, nameEn: true } },
        destination: { select: { nameAr: true, nameEn: true } },
        items: { orderBy: { lineNo: 'asc' } },
        booking: {
          select: {
            number: true,
            customer: { select: { name: true, phone: true } },
            shipper: { select: { name: true, phone: true } },
            consignee: { select: { name: true, phone: true, city: true } },
          },
        },
        movements: {
          where: liveReceipts,
          orderBy: { occurredAt: 'asc' },
          select: {
            occurredAt: true,
            packages: true,
            weightKg: true,
            volumeCbm: true,
            warehouse: { select: { nameAr: true, nameEn: true } },
          },
        },
      },
    });
    const first = s.movements[0]!;
    const sum = (values: (Prisma.Decimal | null)[]) =>
      values.some((v) => v !== null)
        ? values.reduce<Prisma.Decimal>((a, v) => (v === null ? a : a.plus(v)), dec(0))
        : null;
    const base = this.base();
    const sender = s.booking.shipper ?? s.booking.customer;
    return {
      number: s.number,
      bookingNumber: s.booking.number,
      receivedAt: first.occurredAt.toISOString(),
      receivedPlace: { ar: first.warehouse.nameAr, en: first.warehouse.nameEn },
      origin: { ar: s.origin.nameAr, en: s.origin.nameEn },
      destination: { ar: s.destination.nameAr, en: s.destination.nameEn },
      mode: s.mode,
      services: s.services,
      sender: { name: sender.name, phone: sender.phone },
      receiver: s.booking.consignee
        ? {
            name: s.booking.consignee.name,
            phone: s.booking.consignee.phone,
            city: s.booking.consignee.city,
          }
        : null,
      items: s.items.map((i) => ({
        cargoType: i.cargoType,
        description: i.description,
        quantity: i.quantity,
        weightKg: toDecimalStringOrNull(i.weightKg),
        volumeCbm: toDecimalStringOrNull(i.volumeCbm),
      })),
      received: {
        packages: s.movements.reduce((a, m) => a + m.packages, 0),
        weightKg: toDecimalStringOrNull(sum(s.movements.map((m) => m.weightKg))),
        volumeCbm: toDecimalStringOrNull(sum(s.movements.map((m) => m.volumeCbm))),
      },
      trackingQrSvg: base
        ? await QRCode.toString(`${base}/track/${s.trackingToken}`, {
            type: 'svg',
            errorCorrectionLevel: 'M',
            margin: 2,
          })
        : null,
    };
  }

  /** A posted receipt paying this shipment's invoices, in the key's branches, or null. */
  private async receipt(shipmentId: string, receiptId: string, branchIds: readonly string[]) {
    const r = await this.prisma.receipt.findFirst({
      where: {
        id: receiptId,
        status: 'POSTED',
        branchId: { in: [...branchIds] },
        allocations: { some: { invoice: { shipmentId } } },
      },
      select: {
        number: true,
        receiptDate: true,
        amount: true,
        currency: true,
        reference: true,
        customer: { select: { name: true } },
        cashAccount: {
          select: {
            windowCash: {
              select: {
                warehouse: {
                  select: {
                    nameAr: true,
                    nameEn: true,
                    partner: { select: { name: true } },
                  },
                },
              },
            },
          },
        },
        allocations: {
          where: { invoice: { shipmentId } },
          select: {
            amount: true,
            invoice: {
              select: {
                number: true,
                shipment: { select: { number: true, booking: { select: { number: true } } } },
              },
            },
          },
        },
      },
    });
    if (!r) return null;
    const window = r.cashAccount.windowCash?.warehouse ?? null;
    const shipment = r.allocations[0]?.invoice.shipment ?? null;
    return {
      number: r.number,
      receiptDate: fromDbDate(r.receiptDate),
      amount: toDecimalString(r.amount),
      currency: r.currency,
      reference: r.reference,
      customerName: r.customer.name,
      bookingNumber: shipment?.booking.number ?? null,
      shipmentNumber: shipment?.number ?? null,
      place: window
        ? { name: { ar: window.nameAr, en: window.nameEn }, outlet: window.partner?.name ?? null }
        : null,
      invoices: r.allocations.map((a) => ({
        number: a.invoice.number ?? '',
        amount: toDecimalString(a.amount),
      })),
    };
  }

  private async record(caller: BookingRequestCaller, proof: Proof, outcome: string): Promise<void> {
    await this.prisma.csAccessEvent.create({
      data: {
        apiClientId: caller.client.id,
        tokenId: caller.kind === 'customer' ? caller.token.tokenId : null,
        customerId: caller.kind === 'customer' ? caller.token.customerId : null,
        channel: caller.kind === 'customer' ? 'token' : (proof?.channel ?? 'key'),
        route: ROUTE,
        outcome,
      },
    });
  }
}

/**
 * The goods are received (a live goods receipt, whatever status that moved the shipment to: a
 * booking without the warehouse service keeps its status) and neither shipment nor booking is
 * cancelled. Not the stages' sort order (plan 09 section 7).
 */
export async function waybillReady(db: Db, shipmentId: string): Promise<boolean> {
  const s = await db.shipment.findUnique({
    where: { id: shipmentId },
    select: {
      status: true,
      booking: { select: { status: true } },
      movements: { where: liveReceipts, select: { id: true }, take: 1 },
    },
  });
  return (
    s !== null &&
    s.status !== 'CANCELLED' &&
    s.booking.status !== 'CANCELLED' &&
    s.movements.length > 0
  );
}

/** The posted receipts paying a shipment's invoices, in the key's branches, oldest first. */
function shipmentReceipts(db: Db, shipmentId: string, branchIds: readonly string[]) {
  return db.receipt.findMany({
    where: {
      status: 'POSTED',
      branchId: { in: [...branchIds] },
      allocations: { some: { invoice: { shipmentId } } },
    },
    orderBy: [{ receiptDate: 'asc' }, { number: 'asc' }],
    select: { id: true, number: true, receiptDate: true, amount: true, currency: true },
  });
}
