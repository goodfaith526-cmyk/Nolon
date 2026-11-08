import { PalletDetail } from '@/components/pallets/PalletDetail';

export default async function PalletPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PalletDetail id={id} />;
}
