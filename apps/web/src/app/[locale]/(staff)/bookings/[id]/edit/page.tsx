import { BookingEdit } from '@/components/commercial/EditLoaders';

export default async function EditBookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BookingEdit id={id} />;
}
