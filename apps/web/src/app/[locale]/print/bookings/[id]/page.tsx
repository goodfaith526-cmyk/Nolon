import { BookingPrint } from '@/components/print/CommercialPrints';

export default async function BookingPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BookingPrint id={id} />;
}
