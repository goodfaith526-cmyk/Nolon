import { WindowWaybillPrint } from '@/components/print/WindowDeskPrints';

export default async function WindowWaybillPrintPage({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { bookingId } = await params;
  return <WindowWaybillPrint bookingId={bookingId} />;
}
