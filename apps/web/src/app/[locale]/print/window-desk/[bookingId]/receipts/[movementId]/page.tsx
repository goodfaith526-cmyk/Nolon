import { WindowReceiptPrint } from '@/components/print/WindowDeskPrints';

export default async function WindowReceiptPrintPage({
  params,
}: {
  params: Promise<{ bookingId: string; movementId: string }>;
}) {
  const { bookingId, movementId } = await params;
  return <WindowReceiptPrint bookingId={bookingId} movementId={movementId} />;
}
