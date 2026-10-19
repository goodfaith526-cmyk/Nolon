import { TripForm } from '@/components/transport/TripForm';

export default async function NewTripPage({
  searchParams,
}: {
  searchParams: Promise<{ shipmentId?: string | string[] }>;
}) {
  const { shipmentId } = await searchParams;
  return <TripForm shipmentId={typeof shipmentId === 'string' ? shipmentId : undefined} />;
}
