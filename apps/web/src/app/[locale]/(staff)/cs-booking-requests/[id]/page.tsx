import { BotRequestDetail } from '@/components/bot-requests/BotRequestDetail';

export default async function BotRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BotRequestDetail id={id} />;
}
