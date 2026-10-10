import { DraftReviewPage } from '@/components/drafts/DraftReviewPage';

export default async function DraftPage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const { kind, id } = await params;
  return <DraftReviewPage kind={kind} id={id} />;
}
