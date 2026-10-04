import { JournalDetail } from '@/components/finance/JournalDetail';

export default async function JournalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JournalDetail id={id} />;
}
