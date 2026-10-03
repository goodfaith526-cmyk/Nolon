import { ShipmentDetail } from '@/components/shipments/ShipmentDetail';

export default async function ShipmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ShipmentDetail id={id} />;
}
