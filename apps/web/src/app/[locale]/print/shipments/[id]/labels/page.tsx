import { PackageLabelsPrint } from '@/components/print/ShipmentPrints';

/** A line or package number from the query string, when it is one. */
function count(value: string | undefined, pattern: RegExp): number | undefined {
  return value && pattern.test(value) ? Number(value) : undefined;
}

export default async function PackageLabelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ line?: string; from?: string }>;
}) {
  const { id } = await params;
  const { line, from } = await searchParams;
  return (
    <PackageLabelsPrint id={id} line={count(line, /^\d{1,4}$/)} from={count(from, /^\d{1,6}$/)} />
  );
}
