import { WindowPaymentPrint } from '@/components/print/WindowDeskPrints';

export default async function WindowPaymentPrintPage({
  params,
}: {
  params: Promise<{ bookingId: string; receiptId: string }>;
}) {
  const { bookingId, receiptId } = await params;
  return <WindowPaymentPrint bookingId={bookingId} receiptId={receiptId} />;
}
