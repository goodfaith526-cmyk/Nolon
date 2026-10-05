import { ExpenseForm } from '@/components/finance/ExpenseForm';

export default async function EditExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExpenseForm id={id} />;
}
