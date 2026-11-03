import { ShipmentDetail } from '@/components/shipments/ShipmentDetail';
import { StandaloneShell } from '@/components/standalone/StandaloneShell';

/** One shipment in a window of its own (opened from the shipment page): no menu, no way out. */
export default async function StandaloneShipmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <StandaloneShell record={{ kind: 'shipment', id }}>
      <ShipmentDetail id={id} />
    </StandaloneShell>
  );
}
