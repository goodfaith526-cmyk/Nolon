import { ReceiptPrint } from '@/components/print/FinancePrints';

export default async function ReceiptPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReceiptPrint id={id} />;
}
