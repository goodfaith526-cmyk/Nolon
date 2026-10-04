import { JournalEdit } from '@/components/finance/JournalForm';

export default async function EditJournalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JournalEdit id={id} />;
}
