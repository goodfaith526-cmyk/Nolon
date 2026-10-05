import { SupplierPaymentDetail } from '@/components/payables/SupplierPaymentDetail';

export default async function SupplierPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SupplierPaymentDetail id={id} />;
}
