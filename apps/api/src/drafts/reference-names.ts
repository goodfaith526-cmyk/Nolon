import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { shipmentScope } from '../shipments/shipment-scope.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every id written anywhere in a draft's proposed values (keys are field names, not ids). */
export function idsIn(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (UUID.test(value)) out.add(value.toLowerCase());
  } else if (Array.isArray(value)) {
    for (const item of value) idsIn(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) idsIn(item, out);
  }
  return out;
}

const both = (en: string, ar: string) => (en === ar ? en : `${en} / ${ar}`);

/**
 * A readable name for each id in a draft's proposed values, for the assistant's chat card
 * (erp-agents docs/chat-draft-approval.md): the card shows what an approval would record, never a
 * bare id. Only what this user may see: branch-owned records come from their branches, shipments
 * also from the branches they are shared with. An id
 * that names nothing they may see is left out, and the card then sends the person to the review
 * screen instead of offering Approve.
 */
export async function referenceNames(
  prisma: PrismaService,
  user: AuthUser,
  value: unknown,
): Promise<Record<string, string>> {
  const ids = [...idsIn(value)];
  if (ids.length === 0) return {};
  const id = { in: ids };
  const scoped = { id, ...branchScope(user) };
  const [
    branches,
    locations,
    customers,
    parties,
    rateCards,
    quotations,
    shipments,
    warehouses,
    vehicles,
    drivers,
    carriers,
    invoices,
    accounts,
  ] = await Promise.all([
    prisma.branch.findMany({
      where: { id: { in: ids.filter((b) => user.allowedBranchIds.includes(b)) } },
      select: { id: true, code: true, nameEn: true, nameAr: true },
    }),
    prisma.location.findMany({
      where: { id },
      select: { id: true, code: true, nameEn: true, nameAr: true },
    }),
    prisma.customer.findMany({ where: scoped, select: { id: true, number: true, name: true } }),
    prisma.party.findMany({
      where: { id, customer: branchScope(user) },
      select: { id: true, name: true, city: true },
    }),
    prisma.rateCard.findMany({
      where: scoped,
      select: { id: true, chargeTypeCode: true, unit: true, price: true, currency: true },
    }),
    prisma.quotation.findMany({ where: scoped, select: { id: true, number: true } }),
    prisma.shipment.findMany({
      where: { id, ...shipmentScope(user) },
      select: { id: true, number: true },
    }),
    prisma.warehouse.findMany({
      where: scoped,
      select: { id: true, code: true, nameEn: true, nameAr: true },
    }),
    prisma.vehicle.findMany({ where: scoped, select: { id: true, plateNumber: true } }),
    prisma.driver.findMany({ where: scoped, select: { id: true, name: true } }),
    prisma.carrier.findMany({ where: { id }, select: { id: true, name: true } }),
    prisma.customerInvoice.findMany({ where: scoped, select: { id: true, number: true } }),
    prisma.account.findMany({
      where: { id, OR: [{ branchId: null }, branchScope(user)] },
      select: { id: true, code: true, nameEn: true, nameAr: true },
    }),
  ]);
  const names: Record<string, string> = {};
  for (const b of branches) names[b.id] = `${b.code} ${both(b.nameEn, b.nameAr)}`;
  for (const l of locations) names[l.id] = `${l.code} ${both(l.nameEn, l.nameAr)}`;
  for (const c of customers) names[c.id] = `${c.number} ${c.name}`;
  for (const p of parties) names[p.id] = p.city ? `${p.name} (${p.city})` : p.name;
  for (const r of rateCards) {
    names[r.id] = `${r.chargeTypeCode} ${r.price.toFixed()} ${r.currency} / ${r.unit}`;
  }
  for (const q of quotations) names[q.id] = q.number;
  for (const s of shipments) names[s.id] = s.number;
  for (const w of warehouses) names[w.id] = `${w.code} ${both(w.nameEn, w.nameAr)}`;
  for (const v of vehicles) names[v.id] = v.plateNumber;
  for (const d of drivers) names[d.id] = d.name;
  for (const c of carriers) names[c.id] = c.name;
  for (const i of invoices) if (i.number !== null) names[i.id] = i.number;
  for (const a of accounts) names[a.id] = `${a.code} ${both(a.nameEn, a.nameAr)}`;
  return names;
}
