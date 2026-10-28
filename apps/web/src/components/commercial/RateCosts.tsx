'use client';

import {
  RATE_COST_COMPONENTS,
  RATE_UNITS,
  type ExpectedMarginDto,
  type RateCardCostDto,
  type RateCardCostInput,
  type RateCardDto,
  type RateCostComponent,
  type RateUnit,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useMasterData } from '@/lib/master-data';
import { Money } from '../finance/common';
import { PartnerSelect } from '../partners/PartnerSelect';
import { can, useMe } from '../StaffShell';
import { Notice, type NoticeState, useFailureText } from './Notice';

/**
 * A rate card's reference costs and its expected margin (business model plan 6.1): a planning
 * figure, apart from the actual profit read from the books. The API works the margin out and
 * says what is missing; this page shows it as it comes.
 */
export function RateCosts({ rate, onClose }: { rate: RateCardDto; onClose: () => void }) {
  const t = useTranslations('RateCosts');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const failure = useFailureText();
  const [costs, setCosts] = useState<RateCardCostDto[] | null>(null);
  const [editing, setEditing] = useState<RateCostComponent | null>(null);
  const [outletId, setOutletId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [margin, setMargin] = useState<ExpectedMarginDto | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const editable = rate.status !== 'CANCELLED' && can(me, 'rate_costs:update');

  const loadCosts = useCallback(() => {
    api<RateCardCostDto[]>(`/rates/${rate.id}/costs`)
      .then(setCosts)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [rate.id, failure]);

  const loadMargin = useCallback(() => {
    const query = new URLSearchParams();
    if (outletId) query.set('outletId', outletId);
    if (quantity) query.set('quantity', quantity);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    api<ExpectedMarginDto>(`/rates/${rate.id}/expected-margin${suffix}`)
      .then(setMargin)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [rate.id, outletId, quantity, failure]);

  useEffect(loadCosts, [loadCosts]);
  useEffect(loadMargin, [loadMargin, costs]);

  async function save(component: RateCostComponent, body: RateCardCostInput) {
    setNotice(null);
    try {
      setCosts(
        await api<RateCardCostDto[]>(`/rates/${rate.id}/costs/${component}`, {
          method: 'PUT',
          body,
        }),
      );
      setEditing(null);
      setNotice({ ok: true, text: tc('saved') });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    }
  }

  const costOf = (component: RateCostComponent) => costs?.find((c) => c.component === component);
  const lineOf = (component: string) => margin?.lines.find((l) => l.component === component);

  return (
    <section className="card stack">
      <div className="row">
        <h2>{t('title')}</h2>
        <button type="button" onClick={onClose}>
          {t('close')}
        </button>
      </div>
      <p className="muted">{t('planningOnly')}</p>
      <Notice notice={notice} />
      {costs === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('component')}</th>
                <th>{t('cost')}</th>
                <th>{t('perCardUnit', { unit: te(`unit_${rate.unit}`) })}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t('component_OUTLET_COMMISSION')}</td>
                <td className="muted">{t('fromContract')}</td>
                <td>
                  <MarginAmount line={lineOf('OUTLET_COMMISSION')} currency={rate.currency} />
                </td>
                <td />
              </tr>
              {RATE_COST_COMPONENTS.map((component) => {
                const cost = costOf(component);
                return editing === component ? (
                  <tr key={component}>
                    <td colSpan={4}>
                      <CostForm
                        component={component}
                        cost={cost}
                        cardUnit={rate.unit}
                        defaultCurrency={rate.currency}
                        onSave={(body) => void save(component, body)}
                        onCancel={() => setEditing(null)}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={component}>
                    <td>{t(`component_${component}`)}</td>
                    <td dir="ltr">
                      {!cost ? (
                        <span className="muted">{t('notEntered')}</span>
                      ) : cost.status === 'NOT_APPLICABLE' ? (
                        t('notApplicable')
                      ) : (
                        <>
                          <Money value={cost.amount ?? '0'} currency={cost.currency ?? undefined} />
                          {cost.unit ? ` / ${te(`unit_${cost.unit}`)}` : ''}
                          {cost.unitsPerCostUnit ? (
                            <div className="muted">
                              {t('unitsPer', { count: cost.unitsPerCostUnit })}
                            </div>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td>
                      <MarginAmount line={lineOf(component)} currency={rate.currency} />
                    </td>
                    <td>
                      {editable && (
                        <button type="button" onClick={() => setEditing(component)}>
                          {tc('edit')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3>{t('marginTitle')}</h3>
      <div className="grid">
        <label className="field">
          {t('outlet')}
          <PartnerSelect
            kind="SALES_OUTLET"
            branchIds={me.branches.map((b) => b.id)}
            held={null}
            value={outletId}
            onChange={setOutletId}
          />
        </label>
        <label className="field">
          {t('quantity')}
          <input
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            inputMode="decimal"
            dir="ltr"
            placeholder={t('oneUnit')}
          />
        </label>
      </div>
      {margin && (
        <dl className="details">
          <dt>{margin.quantity ? t('linePrice') : t('unitPrice')}</dt>
          <dd>
            <Money value={margin.price} currency={margin.currency} />
          </dd>
          <dt>{t('expectedMargin')}</dt>
          <dd>
            {margin.expectedMargin !== null ? (
              <strong>
                <Money value={margin.expectedMargin} currency={margin.currency} />
              </strong>
            ) : (
              <span className="error">
                {t('incomplete', {
                  missing: margin.missing.map((m) => t(`component_${m}`)).join('، '),
                })}
              </span>
            )}
          </dd>
          <dt>{t('asOf')}</dt>
          <dd dir="ltr">{margin.asOf}</dd>
        </dl>
      )}
    </section>
  );
}

/** A component's share of the margin in the card's currency, or why it has none. */
function MarginAmount({
  line,
  currency,
}: {
  line: ExpectedMarginDto['lines'][number] | undefined;
  currency: string;
}) {
  const t = useTranslations('RateCosts');
  if (!line) return <>—</>;
  if (line.gap) return <span className="muted">{t(`gap_${line.gap}`)}</span>;
  if (line.notApplicable) return <span className="muted">{t('notApplicable')}</span>;
  return <Money value={line.amount ?? '0'} currency={currency} />;
}

function CostForm({
  component,
  cost,
  cardUnit,
  defaultCurrency,
  onSave,
  onCancel,
}: {
  component: RateCostComponent;
  cost: RateCardCostDto | undefined;
  cardUnit: RateUnit;
  defaultCurrency: string;
  onSave: (body: RateCardCostInput) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('RateCosts');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const master = useMasterData();
  const [applicable, setApplicable] = useState(cost?.status !== 'NOT_APPLICABLE');
  const [unit, setUnit] = useState<RateUnit>(cost?.unit ?? cardUnit);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const note = field(form, 'note') || null;
    onSave(
      applicable
        ? {
            status: 'ENTERED',
            amount: field(form, 'amount'),
            currency: field(form, 'currency'),
            unit,
            unitsPerCostUnit: unit === cardUnit ? null : field(form, 'unitsPerCostUnit') || null,
            note,
          }
        : { status: 'NOT_APPLICABLE', note },
    );
  }

  return (
    <form className="stack" autoComplete="off" onSubmit={submit}>
      <strong>{t(`component_${component}`)}</strong>
      <label className="field inline">
        <input
          type="checkbox"
          checked={!applicable}
          onChange={(e) => setApplicable(!e.target.checked)}
        />
        {t('notApplicable')}
      </label>
      {applicable && (
        <div className="grid">
          <label className="field">
            {t('amount')}
            <input
              name="amount"
              required
              inputMode="decimal"
              dir="ltr"
              defaultValue={cost?.amount ?? ''}
            />
          </label>
          <label className="field">
            {t('currency')}
            <select name="currency" defaultValue={cost?.currency ?? defaultCurrency}>
              {master?.currencies
                .filter((c) => c.isActive)
                .map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            {t('unit')}
            <select value={unit} onChange={(e) => setUnit(e.target.value as RateUnit)}>
              {RATE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {te(`unit_${u}`)}
                </option>
              ))}
            </select>
          </label>
          {unit !== cardUnit && (
            <label className="field">
              {t('unitsPerCostUnit', {
                cardUnit: te(`unit_${cardUnit}`),
                costUnit: te(`unit_${unit}`),
              })}
              <input
                name="unitsPerCostUnit"
                inputMode="decimal"
                dir="ltr"
                defaultValue={cost?.unitsPerCostUnit ?? ''}
              />
            </label>
          )}
        </div>
      )}
      <label className="field">
        {tc('notes')}
        <input name="note" maxLength={500} defaultValue={cost?.note ?? ''} />
      </label>
      <div className="actions">
        <button type="submit" className="primary">
          {tc('save')}
        </button>
        <button type="button" onClick={onCancel}>
          {tc('cancel')}
        </button>
      </div>
    </form>
  );
}
