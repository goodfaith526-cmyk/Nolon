import { InvoicePrint } from '@/components/print/FinancePrints';

export default async function InvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoicePrint id={id} />;
}
