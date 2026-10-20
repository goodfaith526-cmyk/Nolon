'use client';

import type { DraftEvidence } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

/**
 * The fields of a draft that one tick confirms together: where the work sits and how long the
 * route takes, values a reviewer reads at a glance. Every other field (amounts, prices, currency,
 * quantities, weights, names, phones, the customer, shipment or status, and any field not named
 * here) keeps its own tick, so a field added later is ticked on its own until it is listed here.
 */
export const GROUPED_EVIDENCE_FIELDS: readonly string[] = [
  'branchId',
  'originLocationId',
  'destinationLocationId',
  'locationId',
  'transitDays',
];

/** Whether one tick confirms this field with the others of its group (only exact field names). */
export function isGroupedField(field: string): boolean {
  return GROUPED_EVIDENCE_FIELDS.includes(field);
}

/**
 * The ticks of one draft version. NOLON drops the words of a value a person edits and moves the
 * version on; the ticks made on the earlier version are dropped too, so the person ticks again
 * what is on screen now.
 */
export function useEvidenceTicks(
  version: number | undefined,
): [string[], (ticked: string[]) => void] {
  const [state, setState] = useState<{ version: number | undefined; fields: string[] }>({
    version,
    fields: [],
  });
  const ticked = state.version === version ? state.fields : [];
  return [ticked, (fields) => setState({ version, fields })];
}

/**
 * The staff member's own words next to each value of a review-screen draft. The assistant checked
 * that the words are theirs, not what they mean: the person ticks each value that matches its
 * words, and Approve stays off until every one is ticked (NOLON refuses it otherwise). The
 * grouped fields (GROUPED_EVIDENCE_FIELDS) share one tick that names each value it covers.
 */
export function EvidenceChecklist({
  evidence,
  values,
  ticked,
  onChange,
  editable,
}: {
  evidence: readonly DraftEvidence[];
  /** Each field's label and value as the draft shows it. */
  values: Record<string, { label: string; value: string }>;
  ticked: readonly string[];
  onChange: (ticked: string[]) => void;
  /** Ticks only while the person can decide. */
  editable: boolean;
}) {
  const t = useTranslations('Drafts');
  const locale = useLocale();
  if (evidence.length === 0) return null;
  const grouped = evidence.filter((e) => isGroupedField(e.field));
  const single = evidence.filter((e) => !isGroupedField(e.field));
  const groupFields = grouped.map((e) => e.field);
  const groupTicked = groupFields.every((f) => ticked.includes(f));
  const labelOf = (field: string) => values[field]?.label ?? field;

  const row = (e: DraftEvidence, tick: boolean) => {
    const shown = values[e.field];
    const id = `evidence-${e.field}`;
    return (
      <tr key={e.field}>
        {editable && (
          <td>
            {tick && (
              <input
                id={id}
                type="checkbox"
                checked={ticked.includes(e.field)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...ticked, e.field]
                      : ticked.filter((f) => f !== e.field),
                  )
                }
              />
            )}
          </td>
        )}
        <td>
          {tick ? (
            <label htmlFor={id}>
              {shown?.label ?? e.field}: <strong>{shown?.value ?? '—'}</strong>
            </label>
          ) : (
            <>
              {shown?.label ?? e.field}: <strong>{shown?.value ?? '—'}</strong>
            </>
          )}
        </td>
        <td>
          <q>{e.quote}</q>
        </td>
      </tr>
    );
  };

  return (
    <div className="card stack">
      <h2>{t('wordsTitle')}</h2>
      {editable && <p className="muted">{t('wordsHint')}</p>}
      <table>
        <thead>
          <tr>
            {editable && <th>{t('wordsTick')}</th>}
            <th>{t('wordsValue')}</th>
            <th>{t('wordsQuote')}</th>
          </tr>
        </thead>
        {grouped.length > 0 && (
          <tbody>
            {editable && (
              <tr>
                <td>
                  <input
                    id="evidence-group"
                    type="checkbox"
                    checked={groupTicked}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...ticked.filter((f) => !groupFields.includes(f)), ...groupFields]
                          : ticked.filter((f) => !groupFields.includes(f)),
                      )
                    }
                  />
                </td>
                <td colSpan={2}>
                  <label htmlFor="evidence-group">
                    {t('wordsGroup', {
                      fields: new Intl.ListFormat(locale).format(groupFields.map(labelOf)),
                    })}
                  </label>
                </td>
              </tr>
            )}
            {grouped.map((e) => row(e, false))}
          </tbody>
        )}
        {single.length > 0 && <tbody>{single.map((e) => row(e, true))}</tbody>}
      </table>
    </div>
  );
}

/** What an approval sends for these words: every field, once all are ticked; else not ready. */
export function confirmedBody(
  evidence: readonly DraftEvidence[],
  ticked: readonly string[],
): { confirmed: string[] } | null {
  const fields = evidence.map((e) => e.field);
  return fields.every((f) => ticked.includes(f)) ? { confirmed: fields } : null;
}
