import { PartnerDetail } from '@/components/partners/PartnerDetail';

export default async function PartnerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PartnerDetail id={id} />;
}
