import { ConsolidationBooking } from '@/components/commercial/EditLoaders';

export default async function ConsolidationBookingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ConsolidationBooking id={id} />;
}
