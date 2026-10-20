import { Customers } from '@/components/commercial/Customers';

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string | string[] }>;
}) {
  const { new: startNew } = await searchParams;
  return <Customers startCreating={startNew === '1'} />;
}
