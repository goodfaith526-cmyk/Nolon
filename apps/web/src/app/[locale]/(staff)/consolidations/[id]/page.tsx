import { ConsolidationDetail } from '@/components/consolidations/ConsolidationDetail';

export default async function ConsolidationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ConsolidationDetail id={id} />;
}
