'use client';

import type {
  BookingDto,
  BookingFromQuotationPreviewDto,
  ConsolidationDto,
  QuotationDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { BookingForm } from './BookingForm';
import { Notice, type NoticeState, useFailureText } from './Notice';
import { QuotationForm } from './QuotationForm';

function useRecord<T>(path: string): { record: T | null; notice: NoticeState | null } {
  const failure = useFailureText();
  const [record, setRecord] = useState<T | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  useEffect(() => {
    api<T>(path)
      .then(setRecord)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [path, failure]);
  return { record, notice };
}

export function QuotationEdit({ id }: { id: string }) {
  const tc = useTranslations('Common');
  const { record, notice } = useRecord<QuotationDto>(`/quotations/${id}`);
  if (notice) return <Notice notice={notice} />;
  return record ? <QuotationForm quotation={record} /> : <p className="muted">{tc('loading')}</p>;
}

export function BookingEdit({ id }: { id: string }) {
  const tc = useTranslations('Common');
  const { record, notice } = useRecord<BookingDto>(`/bookings/${id}`);
  if (notice) return <Notice notice={notice} />;
  return record ? <BookingForm booking={record} /> : <p className="muted">{tc('loading')}</p>;
}

/** A new LCL booking made from a container's page (it joins that container). */
export function ConsolidationBooking({ id }: { id: string }) {
  const tc = useTranslations('Common');
  const { record, notice } = useRecord<ConsolidationDto>(`/consolidations/${id}`);
  if (notice) return <Notice notice={notice} />;
  return record ? <BookingForm consolidation={record} /> : <p className="muted">{tc('loading')}</p>;
}

/** A new booking from an approved quotation: the form filled from its preview, saved by the person. */
export function QuotationBooking({ id }: { id: string }) {
  const tc = useTranslations('Common');
  const { record, notice } = useRecord<BookingFromQuotationPreviewDto>(
    `/bookings/from-quotation/${id}`,
  );
  if (notice) return <Notice notice={notice} />;
  return record ? <BookingForm fromQuotation={record} /> : <p className="muted">{tc('loading')}</p>;
}
