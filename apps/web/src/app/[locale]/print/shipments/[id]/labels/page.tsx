import { PackageLabelsPrint } from '@/components/print/ShipmentPrints';

export default async function PackageLabelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ line?: string }>;
}) {
  const { id } = await params;
  const { line } = await searchParams;
  const lineNo = line && /^\d{1,4}$/.test(line) ? Number(line) : undefined;
  return <PackageLabelsPrint id={id} line={lineNo} />;
}
