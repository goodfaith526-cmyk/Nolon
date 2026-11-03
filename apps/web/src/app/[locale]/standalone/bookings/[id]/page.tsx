import { BookingDetail } from '@/components/commercial/BookingDetail';
import { StandaloneShell } from '@/components/standalone/StandaloneShell';

/** One booking in a window of its own (opened from the booking page): no menu, no way out. */
export default async function StandaloneBookingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <StandaloneShell record={{ kind: 'booking', id }}>
      <BookingDetail id={id} />
    </StandaloneShell>
  );
}
