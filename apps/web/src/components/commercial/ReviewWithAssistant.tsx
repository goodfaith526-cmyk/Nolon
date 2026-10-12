'use client';

import type { CreateFormReviewRequest, FormReviewDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { icons } from '../Icons';
import { useMe } from '../StaffShell';

/** What a refused save keeps for the assistant, or null when it offers nothing to review. */
export function refusedForm(
  error: unknown,
  form: Omit<CreateFormReviewRequest, 'invalidFields' | 'reason'>,
): CreateFormReviewRequest | null {
  // Refused input or a conflicting state: the assistant can explain those. A lost connection
  // or a missing permission it cannot.
  if (!(error instanceof ApiError) || (error.status !== 400 && error.status !== 409)) return null;
  return { ...form, invalidFields: [...error.fields], reason: error.message.slice(0, 500) };
}

/** The assistant's address with the kept form to open, in the fragment (never sent in a request). */
export function assistantReviewUrl(assistantUrl: string, reviewId: string): string {
  const url = new URL(assistantUrl);
  url.hash = `review=${reviewId}`;
  return url.toString();
}

/**
 * "Review with the assistant", next to a refused save: keeps what the form sent for the
 * assistant (its author only may read it, for an hour) and opens the assistant on it. The
 * assistant explains the refusal and, if the person wants, prepares the entry as a draft.
 */
export function ReviewWithAssistant({ refused }: { refused: CreateFormReviewRequest | null }) {
  const me = useMe();
  const t = useTranslations('Common');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // When the browser blocked the new tab: a link to open it by hand.
  const [link, setLink] = useState<string | null>(null);
  const assistantUrl = me.assistantUrl;
  if (!refused || !assistantUrl) return null;

  async function open(target: string) {
    // Opened now, while the click still counts, so the browser does not block it.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    setBusy(true);
    setFailed(false);
    setLink(null);
    try {
      const kept = await api<FormReviewDto>('/assistant-form-reviews', {
        method: 'POST',
        body: refused,
      });
      const url = assistantReviewUrl(target, kept.id);
      if (tab) tab.location.href = url;
      else setLink(url);
    } catch {
      tab?.close();
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row review-with-assistant">
      <button
        type="button"
        className="ghost"
        disabled={busy}
        onClick={() => void open(assistantUrl)}
      >
        {icons.assistant}
        <span>{t('reviewWithAssistant')}</span>
      </button>
      <span className="muted">{t('reviewWithAssistantHint')}</span>
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer">
          {t('openAssistant')}
        </a>
      ) : null}
      {failed ? (
        <span className="error" role="status">
          {t('reviewWithAssistantFailed')}
        </span>
      ) : null}
    </div>
  );
}
