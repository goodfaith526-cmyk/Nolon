import { QuotationBooking } from '@/components/commercial/EditLoaders';

export default async function QuotationBookingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <QuotationBooking id={id} />;
}
