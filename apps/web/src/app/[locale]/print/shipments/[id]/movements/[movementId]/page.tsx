import { MovementPrint } from '@/components/print/ShipmentPrints';

export default async function MovementPrintPage({
  params,
}: {
  params: Promise<{ id: string; movementId: string }>;
}) {
  const { id, movementId } = await params;
  return <MovementPrint id={id} movementId={movementId} />;
}
