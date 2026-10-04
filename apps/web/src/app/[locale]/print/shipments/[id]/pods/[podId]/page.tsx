import { DeliveryNotePrint } from '@/components/print/ShipmentPrints';

export default async function DeliveryNotePage({
  params,
}: {
  params: Promise<{ id: string; podId: string }>;
}) {
  const { id, podId } = await params;
  return <DeliveryNotePrint id={id} podId={podId} />;
}
