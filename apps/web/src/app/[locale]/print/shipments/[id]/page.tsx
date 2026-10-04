import { ShipmentSheetPrint } from '@/components/print/ShipmentPrints';

export default async function ShipmentSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ShipmentSheetPrint id={id} />;
}
