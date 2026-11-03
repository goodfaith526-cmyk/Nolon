import { PartnerStatementPrint } from '@/components/print/PartnerStatementPrint';

export default async function PartnerStatementPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PartnerStatementPrint id={id} />;
}
