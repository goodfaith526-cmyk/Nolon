import { PalletPrint } from '@/components/print/PalletPrint';

export default async function PalletLabelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PalletPrint id={id} />;
}
