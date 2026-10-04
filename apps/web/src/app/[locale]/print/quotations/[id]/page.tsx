import { QuotationPrint } from '@/components/print/CommercialPrints';

export default async function QuotationPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <QuotationPrint id={id} />;
}
