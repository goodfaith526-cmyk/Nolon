import { JournalPrint } from '@/components/print/FinancePrints';

export default async function JournalVoucherPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JournalPrint id={id} />;
}
