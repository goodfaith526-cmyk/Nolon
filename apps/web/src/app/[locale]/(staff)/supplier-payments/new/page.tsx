import { SupplierPaymentForm } from '@/components/payables/SupplierPaymentForm';

export default async function NewSupplierPaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ supplierId?: string | string[] }>;
}) {
  const { supplierId } = await searchParams;
  return (
    <SupplierPaymentForm supplierId={typeof supplierId === 'string' ? supplierId : undefined} />
  );
}
