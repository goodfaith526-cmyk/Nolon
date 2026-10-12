'use client';

import type { DraftEvidence } from '@nolon/shared';
import { useTranslations } from 'next-intl';

/**
 * The staff member's own words next to each value of a review-screen draft. The assistant checked
 * that the words are theirs, not what they mean: the person ticks each value that matches its
 * words, and Approve stays off until every one is ticked (NOLON refuses it otherwise).
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
  if (evidence.length === 0) return null;
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
        <tbody>
          {evidence.map((e) => {
            const shown = values[e.field];
            const id = `evidence-${e.field}`;
            return (
              <tr key={e.field}>
                {editable && (
                  <td>
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
                  </td>
                )}
                <td>
                  <label htmlFor={id}>
                    {shown?.label ?? e.field}: <strong>{shown?.value ?? '—'}</strong>
                  </label>
                </td>
                <td>
                  <q>{e.quote}</q>
                </td>
              </tr>
            );
          })}
        </tbody>
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
