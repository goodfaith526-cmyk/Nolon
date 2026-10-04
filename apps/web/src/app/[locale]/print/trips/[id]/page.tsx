import { TripPrint } from '@/components/print/TripPrint';

export default async function TripSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TripPrint id={id} />;
}
