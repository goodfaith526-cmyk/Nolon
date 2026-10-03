import type { BookingService, BranchCode, CargoType, RateUnit } from '@nolon/shared';
import { toDbDate } from '../common/dates.js';
import { dec } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { computeQuotationAmounts } from '../quotations/quotation-totals.js';

/** Marks the demo set as loaded, so later deploys never add it twice. */
const DEMO_MARKER = 'demo.commercial.v1';

/** Every demo record carries this label, so nobody mistakes it for a real customer. */
const DEMO = '(تجريبي)';

interface DemoCustomer {
  key: string;
  branch: BranchCode;
  kind: 'INDIVIDUAL' | 'COMPANY';
  name: string;
  companyName?: string;
  phone: string;
  city: string;
  countryCode: string;
  contact?: { name: string; phone: string };
  consignee?: { name: string; phone: string; city: string };
}

const CUSTOMERS: readonly DemoCustomer[] = [
  {
    key: 'nile',
    branch: 'DXB',
    kind: 'COMPANY',
    name: `شركة النيل للتجارة ${DEMO}`,
    companyName: 'Nile Trading LLC',
    phone: '+971501234567',
    city: 'Dubai',
    countryCode: 'AE',
    contact: { name: 'أحمد عثمان', phone: '+971501234568' },
    consignee: { name: 'مخازن النيل', phone: '+249912345678', city: 'Port Sudan' },
  },
  {
    key: 'amin',
    branch: 'DXB',
    kind: 'INDIVIDUAL',
    name: `محمد الأمين ${DEMO}`,
    phone: '+971552223344',
    city: 'Sharjah',
    countryCode: 'AE',
    consignee: { name: 'عبد الله الأمين', phone: '+249911112233', city: 'Khartoum' },
  },
  {
    key: 'redsea',
    branch: 'JED',
    kind: 'COMPANY',
    name: `مؤسسة البحر الأحمر ${DEMO}`,
    companyName: 'Red Sea Est.',
    phone: '+966501234567',
    city: 'Jeddah',
    countryCode: 'SA',
    contact: { name: 'خالد الزهراني', phone: '+966501234568' },
    consignee: { name: 'مكتب البحر الأحمر', phone: '+249922334455', city: 'Khartoum' },
  },
  {
    key: 'east',
    branch: 'PTS',
    kind: 'COMPANY',
    name: `شركة الشرق للنقل ${DEMO}`,
    companyName: 'East Transport Co.',
    phone: '+249915556677',
    city: 'Port Sudan',
    countryCode: 'SD',
  },
];

interface DemoRate {
  key: string;
  branch: BranchCode;
  origin: string;
  destination: string;
  mode: 'SEA' | 'ROAD';
  loadType: 'FCL' | 'LCL' | null;
  cargoType: CargoType;
  containerTypeCode: string | null;
  unit: RateUnit;
  price: string;
  minimumCharge?: string;
  transitDays: number;
  approved: boolean;
}

const RATES: readonly DemoRate[] = [
  {
    key: 'jea-pzu-40hc',
    branch: 'DXB',
    origin: 'AEJEA',
    destination: 'SDPZU',
    mode: 'SEA',
    loadType: 'FCL',
    cargoType: 'CONTAINER',
    containerTypeCode: '40HC',
    unit: 'PER_CONTAINER',
    price: '2400',
    transitDays: 9,
    approved: true,
  },
  {
    key: 'jea-pzu-20gp',
    branch: 'DXB',
    origin: 'AEJEA',
    destination: 'SDPZU',
    mode: 'SEA',
    loadType: 'FCL',
    cargoType: 'CONTAINER',
    containerTypeCode: '20GP',
    unit: 'PER_CONTAINER',
    price: '1650',
    transitDays: 9,
    approved: true,
  },
  {
    key: 'jed-pzu-lcl',
    branch: 'JED',
    origin: 'SAJED',
    destination: 'SDPZU',
    mode: 'SEA',
    loadType: 'LCL',
    cargoType: 'GENERAL',
    containerTypeCode: null,
    unit: 'PER_CBM',
    price: '85',
    minimumCharge: '170',
    transitDays: 4,
    approved: true,
  },
  {
    key: 'pzu-krt-road',
    branch: 'PTS',
    origin: 'SDPZU',
    destination: 'SDKRT',
    mode: 'ROAD',
    loadType: null,
    cargoType: 'CONTAINER',
    containerTypeCode: '40HC',
    unit: 'PER_CONTAINER',
    price: '1200',
    transitDays: 3,
    approved: true,
  },
  {
    key: 'jea-pzu-pallet',
    branch: 'DXB',
    origin: 'AEJEA',
    destination: 'SDPZU',
    mode: 'SEA',
    loadType: 'LCL',
    cargoType: 'PALLET',
    containerTypeCode: null,
    unit: 'PER_PALLET',
    price: '95',
    transitDays: 10,
    approved: false,
  },
];

function isoDate(daysFromToday: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

/**
 * Sample customers, rates, quotations and bookings for staging, so every screen has something to
 * open. Loaded once (DEMO_MARKER); every name carries "(تجريبي)". The records go through the same
 * numbering and totals code as real ones. Bookings stay drafts, so confirming them is left to
 * the person trying the system.
 */
export async function seedDemoCommercial(prisma: PrismaClient): Promise<void> {
  if (await prisma.systemSetting.findUnique({ where: { key: DEMO_MARKER } })) {
    console.log('Demo commercial data already loaded.');
    return;
  }
  const admin = await prisma.user.findFirst({
    where: { isActive: true, roles: { some: { role: 'ADMINISTRATOR' } } },
    orderBy: { createdAt: 'asc' },
  });
  if (!admin) {
    console.log('No Administrator yet; demo commercial data skipped.');
    return;
  }
  const branches = new Map(
    (await prisma.branch.findMany()).map((b) => [b.code, { id: b.id, timezone: b.timezone }]),
  );
  const locations = new Map((await prisma.location.findMany()).map((l) => [l.code, l.id]));
  const branchId = (code: BranchCode) => {
    const branch = branches.get(code);
    if (!branch) throw new Error(`Demo data: branch ${code} missing`);
    return branch.id;
  };
  const locationId = (code: string) => {
    const id = locations.get(code);
    if (!id) throw new Error(`Demo data: location ${code} missing`);
    return id;
  };
  const year = isoDate(0).slice(0, 4);
  const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });

  await prisma.$transaction(
    async (tx) => {
      const customers = new Map<
        string,
        { id: string; branchId: string; consigneeId: string | null }
      >();
      for (const c of CUSTOMERS) {
        const number = formatDocumentNumber('CUS', await nextSequenceValue(tx, 'CUSTOMER'));
        const created = await tx.customer.create({
          data: {
            number,
            branchId: branchId(c.branch),
            kind: c.kind,
            name: c.name,
            companyName: c.companyName ?? null,
            phone: c.phone,
            whatsapp: c.phone,
            city: c.city,
            countryCode: c.countryCode,
            preferredCurrency: 'USD',
            paymentTermsDays: c.kind === 'COMPANY' ? 30 : 0,
            notes: 'بيانات تجريبية للتجربة فقط.',
            createdById: admin.id,
            contacts: c.contact
              ? {
                  create: {
                    name: c.contact.name,
                    phone: c.contact.phone,
                    canInquire: true,
                    canReceiveCargo: true,
                    canReceiveDocuments: true,
                    isPrimary: true,
                  },
                }
              : undefined,
            parties: c.consignee
              ? {
                  create: {
                    name: c.consignee.name,
                    phone: c.consignee.phone,
                    countryCode: 'SD',
                    city: c.consignee.city,
                  },
                }
              : undefined,
          },
          include: { parties: true },
        });
        customers.set(c.key, {
          id: created.id,
          branchId: created.branchId,
          consigneeId: created.parties[0]?.id ?? null,
        });
      }

      const rates = new Map<string, { id: string; price: string; minimumCharge: string }>();
      for (const r of RATES) {
        const created = await tx.rateCard.create({
          data: {
            branchId: branchId(r.branch),
            originLocationId: locationId(r.origin),
            destinationLocationId: locationId(r.destination),
            mode: r.mode,
            loadType: r.loadType,
            cargoType: r.cargoType,
            containerTypeCode: r.containerTypeCode,
            unit: r.unit,
            price: dec(r.price),
            minimumCharge: dec(r.minimumCharge ?? '0'),
            currency: 'USD',
            validFrom: toDbDate(isoDate(-30)),
            validTo: toDbDate(isoDate(180)),
            transitDays: r.transitDays,
            status: r.approved ? 'APPROVED' : 'DRAFT',
            approvedById: r.approved ? admin.id : null,
            approvedAt: r.approved ? new Date() : null,
            createdById: admin.id,
          },
        });
        rates.set(r.key, { id: created.id, price: r.price, minimumCharge: r.minimumCharge ?? '0' });
      }

      const quotation = async (input: {
        customer: string;
        origin: string;
        destination: string;
        mode: 'SEA' | 'ROAD';
        loadType: 'FCL' | 'LCL' | null;
        cargoType: CargoType;
        cargoDescription: string;
        status: 'DRAFT' | 'SENT' | 'APPROVED';
        lines: {
          rate?: string;
          chargeTypeCode: string;
          unit: RateUnit;
          quantity: string;
          unitPrice?: string;
          discount?: string;
        }[];
      }) => {
        const customer = customers.get(input.customer);
        if (!customer) throw new Error(`Demo data: customer ${input.customer} missing`);
        const lines = input.lines.map((line) => {
          const rate = line.rate ? rates.get(line.rate) : undefined;
          return {
            ...line,
            rateCardId: rate?.id ?? null,
            unitPrice: dec(rate?.price ?? line.unitPrice ?? '0'),
            minimumCharge: dec(rate?.minimumCharge ?? '0'),
            quantity: dec(line.quantity),
            discount: dec(line.discount ?? '0'),
          };
        });
        const amounts = computeQuotationAmounts(lines, usd.decimalPlaces);
        const number = formatDocumentNumber(
          'QT',
          await nextSequenceValue(tx, 'QUOTATION', year),
          year,
        );
        const now = new Date();
        return tx.quotation.create({
          data: {
            number,
            branchId: customer.branchId,
            customerId: customer.id,
            originLocationId: locationId(input.origin),
            destinationLocationId: locationId(input.destination),
            mode: input.mode,
            loadType: input.loadType,
            cargoType: input.cargoType,
            cargoDescription: input.cargoDescription,
            currency: 'USD',
            subtotal: amounts.subtotal,
            discountTotal: amounts.discountTotal,
            total: amounts.total,
            validUntil: toDbDate(isoDate(30)),
            terms: 'الأسعار لا تشمل الرسوم الجمركية.',
            status: input.status,
            sentAt: input.status === 'DRAFT' ? null : now,
            decidedAt: input.status === 'APPROVED' ? now : null,
            createdById: admin.id,
            lines: {
              create: lines.map((line, index) => {
                const computed = amounts.lines[index];
                if (!computed) throw new Error('Demo data: line amounts missing');
                return {
                  lineNo: index + 1,
                  chargeTypeCode: line.chargeTypeCode,
                  rateCardId: line.rateCardId,
                  unit: line.unit,
                  quantity: line.quantity,
                  unitPrice: line.unitPrice,
                  minimumCharge: line.minimumCharge,
                  discount: line.discount,
                  lineTotal: computed.lineTotal,
                };
              }),
            },
          },
        });
      };

      const approved = await quotation({
        customer: 'nile',
        origin: 'AEJEA',
        destination: 'SDPZU',
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'CONTAINER',
        cargoDescription: 'أدوات منزلية',
        status: 'APPROVED',
        lines: [
          { rate: 'jea-pzu-40hc', chargeTypeCode: 'FREIGHT', unit: 'PER_CONTAINER', quantity: '2' },
          { chargeTypeCode: 'DOCS', unit: 'PER_SHIPMENT', quantity: '1', unitPrice: '75' },
        ],
      });
      await quotation({
        customer: 'redsea',
        origin: 'SAJED',
        destination: 'SDPZU',
        mode: 'SEA',
        loadType: 'LCL',
        cargoType: 'GENERAL',
        cargoDescription: 'مواد غذائية معلبة',
        status: 'SENT',
        lines: [
          { rate: 'jed-pzu-lcl', chargeTypeCode: 'FREIGHT', unit: 'PER_CBM', quantity: '12.5' },
          {
            chargeTypeCode: 'THC',
            unit: 'PER_SHIPMENT',
            quantity: '1',
            unitPrice: '120',
            discount: '20',
          },
        ],
      });
      await quotation({
        customer: 'amin',
        origin: 'AEJEA',
        destination: 'SDPZU',
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'CONTAINER',
        cargoDescription: 'أثاث',
        status: 'DRAFT',
        lines: [
          { rate: 'jea-pzu-20gp', chargeTypeCode: 'FREIGHT', unit: 'PER_CONTAINER', quantity: '1' },
        ],
      });

      const booking = async (input: {
        customer: string;
        quotationId: string | null;
        origin: string;
        destination: string;
        mode: 'SEA' | 'ROAD';
        loadType: 'FCL' | 'LCL' | null;
        cargoType: CargoType;
        cargoDescription: string;
        services: BookingService[];
        items: {
          cargoType: CargoType;
          containerTypeCode: string | null;
          quantity: number;
          weightKg: string;
          volumeCbm?: string;
        }[];
      }) => {
        const customer = customers.get(input.customer);
        if (!customer) throw new Error(`Demo data: customer ${input.customer} missing`);
        const number = formatDocumentNumber(
          'BK',
          await nextSequenceValue(tx, 'BOOKING', year),
          year,
        );
        await tx.booking.create({
          data: {
            number,
            branchId: customer.branchId,
            customerId: customer.id,
            quotationId: input.quotationId,
            originLocationId: locationId(input.origin),
            destinationLocationId: locationId(input.destination),
            mode: input.mode,
            loadType: input.loadType,
            cargoType: input.cargoType,
            cargoDescription: input.cargoDescription,
            services: input.services,
            consigneeId: customer.consigneeId,
            requestedDeparture: toDbDate(isoDate(7)),
            createdById: admin.id,
            items: {
              create: input.items.map((item, index) => ({
                lineNo: index + 1,
                cargoType: item.cargoType,
                containerTypeCode: item.containerTypeCode,
                quantity: item.quantity,
                weightKg: dec(item.weightKg),
                volumeCbm: item.volumeCbm ? dec(item.volumeCbm) : null,
              })),
            },
          },
        });
      };

      await booking({
        customer: 'nile',
        quotationId: approved.id,
        origin: 'AEJEA',
        destination: 'SDPZU',
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'CONTAINER',
        cargoDescription: 'أدوات منزلية',
        services: ['MAIN_FREIGHT', 'CUSTOMS', 'INLAND_TRANSPORT', 'LAST_MILE'],
        items: [
          { cargoType: 'CONTAINER', containerTypeCode: '40HC', quantity: 2, weightKg: '18500' },
        ],
      });
      await booking({
        customer: 'east',
        quotationId: null,
        origin: 'SDPZU',
        destination: 'SDKRT',
        mode: 'ROAD',
        loadType: null,
        cargoType: 'CONTAINER',
        cargoDescription: 'قطع غيار',
        services: ['MAIN_FREIGHT'],
        items: [
          { cargoType: 'CONTAINER', containerTypeCode: '40HC', quantity: 1, weightKg: '12000' },
        ],
      });

      await tx.systemSetting.create({
        data: { key: DEMO_MARKER, value: { loadedAt: new Date().toISOString() } },
      });
    },
    { timeout: 30_000 },
  );
  console.log('Demo commercial data loaded.');
}
