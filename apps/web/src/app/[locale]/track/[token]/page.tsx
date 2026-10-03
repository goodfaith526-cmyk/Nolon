import { PublicTracking } from '@/components/shipments/PublicTracking';

export default async function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicTracking token={token} />;
}
