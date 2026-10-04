'use client';

import { useLocale, useTranslations } from 'next-intl';
import Image from 'next/image';
import { type ReactNode, useEffect, useState } from 'react';
import logoAr from '@/assets/brand/logo-ar.webp';
import logoEn from '@/assets/brand/logo-en.webp';
import { Link } from '@/i18n/navigation';
import { apiText } from '@/lib/api';
import { useLocalName } from '@/lib/master-data';
import { Notice, type NoticeState } from '../commercial/Notice';
import { useMe } from '../StaffShell';

/** The paper of a printout: A4 portrait by default; the labels set their own size. */
export function PageStyle({ size = 'A4 portrait', margin = '12mm' }) {
  return <style>{`@page { size: ${size}; margin: ${margin}; }`}</style>;
}

/**
 * The bar above a printout (never printed): back to the screen it came from, anything the page
 * adds (dates of a statement...), and Print, which the browser also saves as PDF.
 */
export function PrintToolbar({
  back,
  ready,
  children,
}: {
  back: string;
  ready: boolean;
  children?: ReactNode;
}) {
  const t = useTranslations('Print');
  return (
    <div className="print-toolbar no-print">
      <Link href={back} className="button">
        {t('back')}
      </Link>
      {children}
      <button type="button" className="primary" disabled={!ready} onClick={() => window.print()}>
        {t('print')}
      </button>
      <span className="muted">{t('pdfHint')}</span>
    </div>
  );
}

/**
 * The public tracking QR code of a shipment, as a data URL: the API draws it (the link holds only
 * the shipment's random tracking token). Fetched once, so a sheet of labels does not ask again for
 * each label. Null until loaded, or when the user may not see the shipment.
 */
export function useQrSrc(shipmentId: string | null): string | null {
  const [qr, setQr] = useState<{ id: string; src: string } | null>(null);
  useEffect(() => {
    if (!shipmentId) return;
    let cancelled = false;
    void apiText(`/shipments/${shipmentId}/qr.svg`).then((svg) => {
      if (!cancelled && svg) {
        setQr({
          id: shipmentId,
          src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [shipmentId]);
  return qr && qr.id === shipmentId ? qr.src : null;
}

export function QrCode({ src, size = 28 }: { src: string | null; size?: number }) {
  const t = useTranslations('Print');
  if (!src) return null;
  return (
    <figure className="doc-qr" style={{ inlineSize: `${size}mm` }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- an SVG the API drew, as a data URL */}
      <img src={src} alt={t('qrAlt')} />
      <figcaption>{t('qrCaption')}</figcaption>
    </figure>
  );
}

/** Loading text or the failure, while a printout has no data yet. */
export function PrintPending({ notice }: { notice: NoticeState | null }) {
  const tc = useTranslations('Common');
  return (
    <div className="page">
      {notice ? <Notice notice={notice} /> : <p className="muted">{tc('loading')}</p>}
    </div>
  );
}

/**
 * One A4 document: the NOLON logo, company and branch header, the title, number and date, an
 * optional QR code, the body, and a footer with who printed it and when. `watermark` marks a
 * draft or a cancelled document across the page.
 */
export function DocumentSheet({
  title,
  number,
  date,
  branchId,
  qr,
  meta,
  watermark,
  children,
}: {
  title: string;
  number: string | null;
  date: ReactNode;
  branchId: string;
  qr?: string | null;
  /** Extra lines under the number (status...). */
  meta?: ReactNode;
  watermark?: string | null;
  children: ReactNode;
}) {
  const t = useTranslations('Print');
  const locale = useLocale();
  const me = useMe();
  const name = useLocalName();
  const branch = me.branches.find((b) => b.id === branchId);
  const [printedAt] = useState(() =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date()),
  );
  return (
    <article className="sheet">
      {watermark && (
        <div className="watermark" aria-hidden="true">
          {watermark}
        </div>
      )}
      <header className="doc-head">
        <div className="doc-brand">
          <Image src={locale === 'ar' ? logoAr : logoEn} alt="NOLON" width={150} unoptimized />
          <div>
            <strong>{t('company')}</strong>
            {branch && (
              <div className="muted">
                {t('branchLine', { name: name(branch), code: branch.code })}
              </div>
            )}
          </div>
        </div>
        <div className="doc-title">
          <h1>{title}</h1>
          {number && (
            <p className="doc-number" dir="ltr">
              {number}
            </p>
          )}
          <p>{date}</p>
          {meta}
        </div>
        {qr !== undefined && <QrCode src={qr} />}
      </header>
      <div className="doc-body">{children}</div>
      <footer className="doc-foot">
        <span>{t('printedBy', { name: me.fullName, at: printedAt })}</span>
        <span className="page-number" />
      </footer>
    </article>
  );
}

/** A titled block of a printout. */
export function DocSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="doc-section">
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

/** Label and value pairs in two columns; empty values are left out. */
export function DocFields({ fields }: { fields: readonly [string, ReactNode][] }) {
  const shown = fields.filter(([, value]) => value !== null && value !== undefined && value !== '');
  return (
    <dl className="doc-fields">
      {shown.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Boxes for handwritten signatures (name, signature, date). */
export function SignatureBoxes({ labels }: { labels: readonly string[] }) {
  const t = useTranslations('Print');
  return (
    <div className="signatures">
      {labels.map((label) => (
        <div key={label} className="signature-box">
          <strong>{label}</strong>
          <span>{t('signName')}</span>
          <span>{t('signSignature')}</span>
          <span>{t('signDate')}</span>
        </div>
      ))}
    </div>
  );
}

/** A date-time from the API in the page language. */
export function useDateTime(): (iso: string | null) => string {
  const locale = useLocale();
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (iso) => (iso ? format.format(new Date(iso)) : '—');
}
