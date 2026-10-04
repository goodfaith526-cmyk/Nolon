import { SupplierBillForm } from '@/components/payables/SupplierBillForm';

export default async function EditSupplierBillPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SupplierBillForm id={id} />;
}
