import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CargoType,
  CsContactDto,
  CsCustomerDto,
  CsInvoiceDto,
  CsInvoiceState,
  CsShipmentDto,
  CsShipmentState,
  CsShipmentSummaryDto,
  CustomerKind,
  LoadType,
  PublicLocationDto,
  ShipmentEventKind,
  ShipmentStatus,
  ShippingMode,
} from '@nolon/shared';
import { fromDbDate, fromDbDateOrNull } from '../common/dates.js';
import { type Decimal, toDecimalString, toDecimalStringOrNull } from '../common/money.js';
import { uuidList } from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { publicStatus, publicTimeline, replayHistory } from '../shipments/state-machine.js';
import type { ApiClientAuth } from './api-client.guard.js';

interface CustomerRow {
  id: string;
  number: string;
  branchCode: string;
  kind: CustomerKind;
  name: string;
  company_name: string | null;
  phone: string;
  whatsapp: string | null;
  email: string | null;
  preferred_locale: string;
  preferred_currency: string | null;
  is_active: boolean;
}

interface ContactRow {
  customer_id: string;
  name: string;
  position: string | null;
  phone: string;
  email: string | null;
  can_inquire: boolean;
  can_receive_cargo: boolean;
  can_receive_documents: boolean;
  is_primary: boolean;
}

interface ShipmentRow {
  id: string;
  number: string;
  customerNumber: string;
  status: ShipmentStatus;
  mode: ShippingMode;
  load_type: LoadType | null;
  cargo_type: CargoType;
  origin_location_id: string;
  destination_location_id: string;
  current_location_id: string | null;
  vessel_name: string | null;
  voyage_number: string | null;
  bl_number: string | null;
  etd: Date | null;
  eta: Date | null;
  packages: number;
  weight_kg: Decimal | null;
  volume_cbm: Decimal | null;
}

interface InvoiceRow {
  number: string;
  shipmentNumber: string | null;
  invoice_date: Date;
  due_date: Date;
  currency: string;
  total: Decimal;
  paid_amount: Decimal;
  credited_amount: Decimal;
  balance: Decimal;
}

const DONE: readonly ShipmentStatus[] = ['DELIVERED', 'CLOSED'];

/**
 * The Customer Service API (scope section 17). Every read goes through the customer-safe views
 * (cs_customers, cs_customer_contacts, cs_shipments, cs_shipment_events, cs_invoices; migration
 * customer_service_api) and the public location names, never the tables, and is limited to the
 * key's branches (AGENTS.md rule 2). A record outside them is "not found", as one that does not
 * exist. A shipment counts only in the branch that owns it: sharing it with another branch
 * (shipment_branches) is for staff work and does not open it to that branch's key.
 */
@Injectable()
export class CustomerServiceService {
  constructor(private readonly prisma: PrismaService) {}

  /** Customers whose phone, WhatsApp or an authorized person's phone (may inquire) is `phone`. */
  async byPhone(client: ApiClientAuth, phone: string): Promise<CsCustomerDto[]> {
    if (client.allowedBranchIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<CustomerRow[]>`
      SELECT c.*, b."code" AS "branchCode"
      FROM "cs_customers" c
      JOIN "branches" b ON b."id" = c."branch_id"
      WHERE c."branch_id" IN ${uuidList(client.allowedBranchIds)}
        AND (c."phone" = ${phone} OR c."whatsapp" = ${phone} OR EXISTS (
          SELECT 1 FROM "cs_customer_contacts" k
          WHERE k."customer_id" = c."id" AND k."phone" = ${phone} AND k."can_inquire"))
      ORDER BY c."number"
      LIMIT 10`;
    return this.withContacts(rows);
  }

  async customer(client: ApiClientAuth, number: string): Promise<CsCustomerDto> {
    const [dto] = await this.withContacts([await this.findCustomer(client, number)]);
    if (!dto) throw new NotFoundException('Customer not found');
    return dto;
  }

  async shipments(
    client: ApiClientAuth,
    customerNumber: string,
    state: CsShipmentState,
    limit: number,
  ): Promise<CsShipmentSummaryDto[]> {
    const customer = await this.findCustomer(client, customerNumber);
    const filter =
      state === 'active'
        ? Prisma.sql`AND s."status"::text NOT IN ('DELIVERED', 'CLOSED', 'CANCELLED')`
        : state === 'delivered'
          ? Prisma.sql`AND s."status"::text IN ('DELIVERED', 'CLOSED')`
          : Prisma.empty;
    const rows = await this.prisma.$queryRaw<ShipmentRow[]>`
      SELECT s.*, ${customer.number} AS "customerNumber"
      FROM "cs_shipments" s
      WHERE s."customer_id" = ${customer.id}::uuid
        AND s."branch_id" IN ${uuidList(client.allowedBranchIds)}
        ${filter}
      ORDER BY s."created_at" DESC, s."number" DESC
      LIMIT ${limit}`;
    const locations = await this.locations(rows.flatMap(locationIds));
    return rows.map((r) => summary(r, locations));
  }

  async shipment(client: ApiClientAuth, number: string): Promise<CsShipmentDto> {
    if (client.allowedBranchIds.length === 0) throw new NotFoundException('Shipment not found');
    const [row] = await this.prisma.$queryRaw<ShipmentRow[]>`
      SELECT s.*, c."number" AS "customerNumber"
      FROM "cs_shipments" s
      JOIN "cs_customers" c ON c."id" = s."customer_id"
      WHERE s."number" = ${number}
        AND s."branch_id" IN ${uuidList(client.allowedBranchIds)}`;
    if (!row) throw new NotFoundException('Shipment not found');
    const events = await this.prisma.$queryRaw<
      {
        kind: ShipmentEventKind;
        status: ShipmentStatus;
        occurred_at: Date;
        location_id: string | null;
      }[]
    >`
      SELECT e."kind", e."status", e."occurred_at", e."location_id"
      FROM "cs_shipment_events" e
      WHERE e."shipment_id" = ${row.id}::uuid
      ORDER BY e."id"`;
    const timeline = publicTimeline(
      replayHistory(
        events.map((e) => ({
          kind: e.kind,
          status: e.status,
          occurredAt: e.occurred_at,
          locationId: e.location_id,
        })),
      ),
    );
    const locations = await this.locations([
      ...locationIds(row),
      ...timeline.flatMap((e) => (e.locationId ? [e.locationId] : [])),
    ]);
    return {
      ...summary(row, locations),
      customerNumber: row.customerNumber,
      cargoType: row.cargo_type,
      currentLocation: row.current_location_id
        ? (locations.get(row.current_location_id) ?? null)
        : null,
      vesselName: row.vessel_name,
      voyageNumber: row.voyage_number,
      blNumber: row.bl_number,
      packages: row.packages,
      weightKg: toDecimalStringOrNull(row.weight_kg),
      volumeCbm: toDecimalStringOrNull(row.volume_cbm),
      timeline: timeline.map((e) => ({
        status: e.status,
        occurredAt: e.occurredAt.toISOString(),
        location: e.locationId ? (locations.get(e.locationId) ?? null) : null,
      })),
    };
  }

  async invoices(
    client: ApiClientAuth,
    customerNumber: string,
    state: CsInvoiceState,
    limit: number,
  ): Promise<CsInvoiceDto[]> {
    const customer = await this.findCustomer(client, customerNumber);
    const rows = await this.prisma.$queryRaw<InvoiceRow[]>`
      SELECT i."number", s."number" AS "shipmentNumber", i."invoice_date", i."due_date",
             i."currency", i."total", i."paid_amount", i."credited_amount", i."balance"
      FROM "cs_invoices" i
      LEFT JOIN "cs_shipments" s ON s."id" = i."shipment_id"
      WHERE i."customer_id" = ${customer.id}::uuid
        AND i."branch_id" IN ${uuidList(client.allowedBranchIds)}
        ${state === 'open' ? Prisma.sql`AND i."balance" > 0` : Prisma.empty}
      ORDER BY i."due_date" DESC, i."number" DESC
      LIMIT ${limit}`;
    return rows.map((r) => ({
      number: r.number,
      shipmentNumber: r.shipmentNumber,
      invoiceDate: fromDbDate(r.invoice_date),
      dueDate: fromDbDate(r.due_date),
      currency: r.currency,
      total: toDecimalString(r.total),
      paid: toDecimalString(r.paid_amount),
      credited: toDecimalString(r.credited_amount),
      balance: toDecimalString(r.balance),
    }));
  }

  private async findCustomer(client: ApiClientAuth, number: string): Promise<CustomerRow> {
    const [row] =
      client.allowedBranchIds.length === 0
        ? []
        : await this.prisma.$queryRaw<CustomerRow[]>`
            SELECT c.*, b."code" AS "branchCode"
            FROM "cs_customers" c
            JOIN "branches" b ON b."id" = c."branch_id"
            WHERE c."number" = ${number}
              AND c."branch_id" IN ${uuidList(client.allowedBranchIds)}`;
    if (!row) throw new NotFoundException('Customer not found');
    return row;
  }

  private async withContacts(rows: readonly CustomerRow[]): Promise<CsCustomerDto[]> {
    if (rows.length === 0) return [];
    const contacts = await this.prisma.$queryRaw<ContactRow[]>`
      SELECT k.* FROM "cs_customer_contacts" k
      WHERE k."customer_id" IN ${uuidList(rows.map((r) => r.id))}
      ORDER BY k."is_primary" DESC, k."name"`;
    return rows.map((r) => ({
      number: r.number,
      branchCode: r.branchCode,
      kind: r.kind,
      name: r.name,
      companyName: r.company_name,
      phone: r.phone,
      whatsapp: r.whatsapp,
      email: r.email,
      preferredLocale: r.preferred_locale,
      preferredCurrency: r.preferred_currency,
      isActive: r.is_active,
      contacts: contacts.filter((k) => k.customer_id === r.id).map(contact),
    }));
  }

  /** Locations are public master data: code and names only. */
  private async locations(ids: readonly string[]): Promise<Map<string, PublicLocationDto>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.location.findMany({
      where: { id: { in: unique } },
      select: { id: true, code: true, nameEn: true, nameAr: true },
    });
    return new Map(rows.map((l) => [l.id, { code: l.code, nameEn: l.nameEn, nameAr: l.nameAr }]));
  }
}

function contact(k: ContactRow): CsContactDto {
  return {
    name: k.name,
    position: k.position,
    phone: k.phone,
    email: k.email,
    canInquire: k.can_inquire,
    canReceiveCargo: k.can_receive_cargo,
    canReceiveDocuments: k.can_receive_documents,
    isPrimary: k.is_primary,
  };
}

function locationIds(r: ShipmentRow): string[] {
  return [
    r.origin_location_id,
    r.destination_location_id,
    ...(r.current_location_id ? [r.current_location_id] : []),
  ];
}

const UNKNOWN: PublicLocationDto = { code: '', nameEn: '', nameAr: '' };

function summary(r: ShipmentRow, locations: Map<string, PublicLocationDto>): CsShipmentSummaryDto {
  return {
    number: r.number,
    status: r.status,
    publicStatus: publicStatus(r.status) ?? (DONE.includes(r.status) ? 'DELIVERED' : null),
    mode: r.mode,
    loadType: r.load_type,
    origin: locations.get(r.origin_location_id) ?? UNKNOWN,
    destination: locations.get(r.destination_location_id) ?? UNKNOWN,
    etd: fromDbDateOrNull(r.etd),
    eta: fromDbDateOrNull(r.eta),
  };
}
