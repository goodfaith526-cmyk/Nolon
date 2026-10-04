import { ExpenseDetail } from '@/components/finance/ExpenseDetail';

export default async function ExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExpenseDetail id={id} />;
}
