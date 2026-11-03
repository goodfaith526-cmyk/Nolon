'use client';

import type { CommissionsDueDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Notice } from '../commercial/Notice';
import { Money, useRecord } from '../finance/common';
import { can, useMe } from '../StaffShell';

/**
 * Report z4 (plan 07, 7): the partner commissions not settled yet, by partner, branch and currency,
 * aged from their entries, with the check against the accrued commissions account per branch.
 * The API computes every figure in the user's branches.
 */
export function CommissionsDue() {
  const t = useTranslations('Reports');
  const tc = useTranslations('Common');
  const me = useMe();
  const allowed = can(me, 'partner_commissions:view');
  const { record: r, notice } = useRecord<CommissionsDueDto>('/partner-commissions/due');
  if (!allowed) return <p className="error">{tc('noAccess')}</p>;
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('partnerCommissions')}</h1>
          <p className="muted">{t('partnerCommissionsHint')}</p>
        </div>
        <Link href="/reports" className="button">
          {t('allReports')}
        </Link>
      </div>
      {!r ? (
        notice ? (
          <Notice notice={notice} />
        ) : (
          <p className="muted">{tc('loading')}</p>
        )
      ) : (
        <>
          <p className="muted">
            {t('asOf')} <span dir="ltr">{r.asOf}</span>
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('partnerCol')}</th>
                  <th>{t('branch')}</th>
                  <th>{t('openCol')}</th>
                  <th>{t('inStatementCol')}</th>
                  <th>{t('unsettledCol')}</th>
                  <th>{t('totalUsd')}</th>
                  <th>{t('age0')}</th>
                  <th>{t('age1')}</th>
                  <th>{t('age2')}</th>
                  <th>{t('age3')}</th>
                  <th>{t('heldCol')}</th>
                </tr>
              </thead>
              <tbody>
                {r.rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="muted">
                      {t('nothingOpen')}
                    </td>
                  </tr>
                )}
                {r.rows.map((x) => (
                  <tr key={`${x.partnerId}:${x.branchId}:${x.currency}`}>
                    <td>
                      <Link href={`/partners/${x.partnerId}`}>{x.partnerName}</Link>{' '}
                      <span className="muted" dir="ltr">
                        {x.partnerNumber}
                      </span>
                      {x.owesNolon && <span className="badge">{t('owesNolon')}</span>}
                    </td>
                    <td>{x.branchCode}</td>
                    <td dir="ltr">
                      <Money value={x.open} currency={x.currency} />
                    </td>
                    <td dir="ltr">
                      <Money value={x.inStatement} currency={x.currency} />
                    </td>
                    <td dir="ltr">
                      <Money value={x.unsettled} currency={x.currency} />
                    </td>
                    <td dir="ltr">
                      <Money value={x.unsettledUsd} currency="USD" />
                    </td>
                    {x.ages.map((age, index) => (
                      <td key={index} dir="ltr">
                        <Money value={age} />
                      </td>
                    ))}
                    <td>{x.holds > 0 ? x.holds : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.branches.length > 0 && (
            <>
              <h2>{t('reconciliation')}</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('branch')}</th>
                      <th>{t('subLedgerUsd')}</th>
                      <th>{t('ledgerUsd')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {r.branches.map((b) => (
                      <tr key={b.branchId}>
                        <td>{b.branchCode}</td>
                        <td dir="ltr">
                          <Money value={b.subLedgerUsd} currency="USD" />
                        </td>
                        <td dir="ltr">
                          <Money value={b.ledgerUsd} currency="USD" />
                        </td>
                        <td className={b.matches ? '' : 'error'}>
                          {b.matches ? t('matches') : t('differs')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
