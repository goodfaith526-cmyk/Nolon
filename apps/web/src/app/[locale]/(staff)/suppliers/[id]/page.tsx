import { SupplierDetail } from '@/components/payables/SupplierDetail';

export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SupplierDetail id={id} />;
}
