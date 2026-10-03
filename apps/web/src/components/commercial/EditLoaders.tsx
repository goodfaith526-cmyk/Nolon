'use client';

import type { BookingDto, QuotationDto } from '@nolon/shared';
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
