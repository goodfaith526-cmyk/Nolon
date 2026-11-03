import { PartnerStatement } from '@/components/partners/PartnerStatement';

export default async function PartnerStatementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PartnerStatement id={id} />;
}
