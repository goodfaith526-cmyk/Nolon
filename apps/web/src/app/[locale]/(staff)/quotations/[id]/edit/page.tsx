import { QuotationEdit } from '@/components/commercial/EditLoaders';

export default async function EditQuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <QuotationEdit id={id} />;
}
