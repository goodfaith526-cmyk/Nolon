import { InvoiceEdit } from '@/components/finance/InvoiceForm';

export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceEdit id={id} />;
}
