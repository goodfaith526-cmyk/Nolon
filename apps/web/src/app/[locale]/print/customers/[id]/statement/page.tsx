import { StatementPrint } from '@/components/print/FinancePrints';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function StatementPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { id } = await params;
  const { from, to } = await searchParams;
  return (
    <StatementPrint
      customerId={id}
      from={from && DATE.test(from) ? from : undefined}
      to={to && DATE.test(to) ? to : undefined}
    />
  );
}
