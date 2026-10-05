import { SupplierBillDetail } from '@/components/payables/SupplierBillDetail';

export default async function SupplierBillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SupplierBillDetail id={id} />;
}
