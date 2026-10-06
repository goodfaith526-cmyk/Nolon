'use client';

import type { ShipmentConsolidationDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { StatusBadge } from '../StatusBadge';

/** The consolidated containers an LCL shipment is (or was) in, on the shipment page. */
export function ShipmentConsolidations({ shipmentId }: { shipmentId: string }) {
  const t = useTranslations('Consolidations');
  const tc = useTranslations('Common');
  const failure = useFailureText();
  const [list, setList] = useState<ShipmentConsolidationDto[] | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<ShipmentConsolidationDto[]>(`/shipments/${shipmentId}/consolidations`)
      .then((items) => {
        if (!cancelled) setList(items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [shipmentId, failure]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('shipmentPanel')}</h2>
      </div>
      <Notice notice={notice} />
      {list === null ? (
        !notice && <p className="empty">{tc('loading')}</p>
      ) : list.length === 0 ? (
        <p className="empty">{t('notConsolidated')}</p>
      ) : (
        <ul className="plain panel-body">
          {list.map((c) => (
            <li key={c.id} className={`line${c.status === 'CANCELLED' ? ' inactive' : ''}`}>
              {c.canOpen ? (
                <Link href={`/consolidations/${c.id}`} dir="ltr">
                  {c.number}
                </Link>
              ) : (
                <span dir="ltr">{c.number}</span>
              )}
              {c.containerNumber && <bdi dir="ltr">{c.containerNumber}</bdi>}
              <StatusBadge kind="consolidation" status={c.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
