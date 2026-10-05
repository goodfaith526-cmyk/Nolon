import { SupplierBills } from '@/components/payables/SupplierBills';

export default async function SupplierBillsPage({
  searchParams,
}: {
  searchParams: Promise<{ supplierId?: string | string[] }>;
}) {
  const { supplierId } = await searchParams;
  return <SupplierBills supplierId={typeof supplierId === 'string' ? supplierId : undefined} />;
}
