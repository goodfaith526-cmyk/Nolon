'use client';

import type { Locale, PublicLocationDto, PublicTrackingDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import Image from 'next/image';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import logoAr from '@/assets/brand/logo-ar.webp';
import logoEn from '@/assets/brand/logo-en.webp';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { ApiError, api } from '@/lib/api';
import { field } from '@/lib/form';

function TrackFrame({ children }: { children: ReactNode }) {
  const t = useTranslations('Track');
  const locale = useLocale();
  const pathname = usePathname();
  const otherLocale: Locale = locale === 'ar' ? 'en' : 'ar';
  return (
    <main className="track-page">
      <header className="track-head">
        <Image
          src={locale === 'ar' ? logoAr : logoEn}
          alt="NOLON"
          className="track-logo"
          width={140}
          priority
          unoptimized
        />
        <Link href={pathname} locale={otherLocale} className="button ghost">
          {t('switchLocale')}
        </Link>
      </header>
      {children}
    </main>
  );
}

/** Public tracking by the link's random token (no sign-in). Shows only the safe fields. */
export function PublicTracking({ token }: { token: string }) {
  const t = useTranslations('Track');
  const tp = useTranslations('PublicStatus');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const [data, setData] = useState<PublicTrackingDto | null>(null);
  const [error, setError] = useState<'notFound' | 'tooMany' | 'failed' | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<PublicTrackingDto>(`/public/tracking/${encodeURIComponent(token)}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const status = e instanceof ApiError ? e.status : 0;
        setError(
          status === 404 || status === 400 ? 'notFound' : status === 429 ? 'tooMany' : 'failed',
        );
      });
    // Staff who can open this shipment get a shortcut to it; for anyone else this is a 401/404.
    api<{ id: string }>(`/shipments/by-token/${encodeURIComponent(token)}`)
      .then((s) => {
        if (!cancelled) setStaffId(s.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token]);

  const name = (l: PublicLocationDto) => (locale === 'ar' ? l.nameAr : l.nameEn);
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' });

  return (
    <TrackFrame>
      {error && (
        <div className="card stack">
          <p className="error">{t(error)}</p>
          <Link href="/track" className="button">
            {t('lookupTitle')}
          </Link>
        </div>
      )}
      {!data && !error && <p className="muted">{t('loading')}</p>}
      {data && (
        <div className="stack">
          <div className="card stack track-summary">
            <p className="muted">{t('reference')}</p>
            <h1 dir="ltr">{data.reference}</h1>
            <span className={`badge badge-public badge-${data.status}`}>{tp(data.status)}</span>
            <div className="track-route">
              <div>
                <span className="muted">{t('from')}</span>
                <strong>{name(data.origin)}</strong>
              </div>
              <span className="track-arrow" aria-hidden="true">
                {locale === 'ar' ? '←' : '→'}
              </span>
              <div>
                <span className="muted">{t('to')}</span>
                <strong>{name(data.destination)}</strong>
              </div>
            </div>
            <dl className="details flat">
              <dt>{t('mode')}</dt>
              <dd>{te(`mode_${data.mode}`)}</dd>
              <dt>{t('currentLocation')}</dt>
              <dd>{data.currentLocation ? name(data.currentLocation) : '—'}</dd>
              <dt>{t('eta')}</dt>
              <dd>{data.eta ? date.format(new Date(`${data.eta}T00:00:00Z`)) : '—'}</dd>
            </dl>
            {staffId && (
              <Link href={`/shipments/${staffId}`} className="button primary">
                {t('openInSystem')}
              </Link>
            )}
          </div>
          <div className="card stack">
            <h2>{t('timeline')}</h2>
            <ol className="timeline">
              {[...data.timeline].reverse().map((entry, index) => (
                <li key={`${entry.occurredAt}-${index}`} className="timeline-item">
                  <strong>{tp(entry.status)}</strong>
                  <div className="muted">
                    {dateTime.format(new Date(entry.occurredAt))}
                    {entry.location ? ` · ${name(entry.location)}` : ''}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </TrackFrame>
  );
}

/** Find a shipment by its number and the last 4 digits of a registered phone. */
export function TrackingLookup() {
  const t = useTranslations('Track');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { token } = await api<{ token: string }>('/public/tracking/lookup', {
        method: 'POST',
        body: { reference: field(form, 'reference').trim(), phoneLast4: field(form, 'phoneLast4') },
      });
      router.push(`/track/${token}`);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setError(
        status === 429
          ? t('tooMany')
          : status === 404 || status === 400
            ? t('noMatch')
            : t('failed'),
      );
      setBusy(false);
    }
  }

  return (
    <TrackFrame>
      <form className="card stack narrow" onSubmit={(e) => void onSubmit(e)}>
        <h1>{t('lookupTitle')}</h1>
        <p className="muted">{t('lookupHint')}</p>
        <label className="field">
          <span>{t('reference')}</span>
          <input
            name="reference"
            required
            dir="ltr"
            placeholder="NOL-SHP-2026-000001"
            maxLength={30}
          />
        </label>
        <label className="field">
          <span>{t('phoneLast4')}</span>
          <input
            name="phoneLast4"
            required
            dir="ltr"
            inputMode="numeric"
            pattern="[0-9]{4}"
            maxLength={4}
            autoComplete="off"
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {t('track')}
        </button>
      </form>
    </TrackFrame>
  );
}
