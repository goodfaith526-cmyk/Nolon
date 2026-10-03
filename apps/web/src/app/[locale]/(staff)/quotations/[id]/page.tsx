import { QuotationDetail } from '@/components/commercial/QuotationDetail';

export default async function QuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <QuotationDetail id={id} />;
}
