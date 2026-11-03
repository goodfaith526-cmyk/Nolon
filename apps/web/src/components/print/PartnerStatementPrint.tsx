'use client';

import type { PartnerStatementDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Money, useRecord } from '../finance/common';
import { StatementLines } from '../partners/PartnerStatement';
import {
  DocFields,
  DocSection,
  DocumentSheet,
  PageStyle,
  PrintPending,
  PrintToolbar,
  SignatureBoxes,
} from './PrintKit';

/** A partner's commission statement (plan 07, 5.3), on the customer statement's sheet. */
export function PartnerStatementPrint({ id }: { id: string }) {
  const t = useTranslations('PartnerStatement');
  const tp = useTranslations('PartnerCommissions');
  const tr = useTranslations('Print');
  const { record: s, notice } = useRecord<PartnerStatementDto>(`/partner-statements/${id}`);
  const toolbar = <PrintToolbar back={`/partner-statements/${id}`} ready={s !== null} />;
  if (!s) {
    return (
      <>
        {toolbar}
        <PrintPending notice={notice} />
      </>
    );
  }
  return (
    <>
      <PageStyle />
      {toolbar}
      <DocumentSheet
        title={t('title')}
        number={s.number}
        date={<span dir="ltr">{s.periodTo}</span>}
        branchId={s.branchId}
        watermark={s.status === 'CANCELLED' ? tp('statementStatus_CANCELLED') : null}
      >
        <DocFields
          fields={[
            [t('partner'), `${s.partnerName} (${s.partnerNumber})`],
            [t('periodTo'), <span dir="ltr">{s.periodTo}</span>],
            [t('currency'), s.currency],
            [t('status'), tp(`statementStatus_${s.status}`)],
            [t('bill'), s.billNumber ? <span dir="ltr">{s.billNumber}</span> : null],
          ]}
        />
        <DocSection>
          <StatementLines statement={s} className="doc-table" />
          {s.currency !== 'USD' && (
            <p className="muted">
              {t('totalUsd')} <Money value={s.totalUsd} currency="USD" />
            </p>
          )}
        </DocSection>
        <p className="muted">{t('note')}</p>
        <SignatureBoxes labels={[tr('signForNolon'), t('partner')]} />
      </DocumentSheet>
    </>
  );
}
