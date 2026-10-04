import { CreditNoteDetail } from '@/components/finance/CreditNoteDetail';

export default async function CreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CreditNoteDetail id={id} />;
}
