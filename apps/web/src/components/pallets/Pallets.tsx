'use client';

import {
  PALLET_STATUSES,
  type Page,
  type PalletDto,
  type PalletStatus,
  type PalletSummaryDto,
  type WarehouseDto,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useBranchCode } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { CarrierLabel } from './common';

/** Plan 15-3: the pallets of the user's branches, and a new one in a warehouse. */
export function Pallets() {
  const t = useTranslations('Pallets');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const me = useMe();
  const router = useRouter();
  const branchCode = useBranchCode(me);
  const failure = useFailureText();
  const [status, setStatus] = useState<PalletStatus | ''>('');
  const [page, setPage] = useState<Page<PalletSummaryDto> | null>(null);
  const [warehouses, setWarehouses] = useState<WarehouseDto[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const canCreate = can(me, 'warehouse:create');

  const load = useCallback(() => {
    api<Page<PalletSummaryDto>>(`/pallets?pageSize=50${status ? `&status=${status}` : ''}`)
      .then(setPage)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [status, failure]);

  useEffect(() => load(), [load]);
  useEffect(() => {
    if (!canCreate) return;
    api<WarehouseDto[]>('/warehouses')
      .then((list) => setWarehouses(list.filter((w) => w.isActive)))
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [canCreate, failure]);

  if (!me.palletsEnabled || !can(me, 'warehouse:view')) {
    return <p className="error">{tc('noAccess')}</p>;
  }

  async function create() {
    setBusy(true);
    try {
      const made = await api<PalletDto>('/pallets', { method: 'POST', body: { warehouseId } });
      router.push(`/pallets/${made.id}`);
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
      setBusy(false);
    }
  }

  const name = (n: { ar: string; en: string }) => (locale === 'ar' ? n.ar : n.en);
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('hint')}</p>
        </div>
      </div>
      <Notice notice={notice} />
      {canCreate && (
        <form
          className="card row"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="field grow">
            <span>{t('warehouse')}</span>
            <select required value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="" />
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {locale === 'ar' ? w.nameAr : w.nameEn} ({w.code})
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary" disabled={busy || !warehouseId}>
            {t('new')}
          </button>
        </form>
      )}
      <div className="row">
        <select value={status} onChange={(e) => setStatus(e.target.value as PalletStatus | '')}>
          <option value="">{tc('all')}</option>
          {PALLET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te(`pallet_${s}`)}
            </option>
          ))}
        </select>
      </div>
      {page === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : page.items.length === 0 ? (
        <p className="empty">{t('none')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('number')}</th>
                <th>{t('warehouse')}</th>
                <th>{t('shipmentsCount')}</th>
                <th>{t('carrier')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((p) => (
                <tr key={p.id} className={p.status === 'CANCELLED' ? 'inactive' : ''}>
                  <td dir="ltr">
                    <Link href={`/pallets/${p.id}`}>{p.number}</Link>
                    <div className="muted">{branchCode(p.branchId)}</div>
                  </td>
                  <td>{name(p.warehouseName)}</td>
                  <td>{p.shipmentCount}</td>
                  <td>{p.carrier ? <CarrierLabel carrier={p.carrier} /> : '—'}</td>
                  <td>
                    <StatusBadge kind="pallet" status={p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
