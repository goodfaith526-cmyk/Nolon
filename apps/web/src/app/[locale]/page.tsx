import { isLocale, type Locale } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { use } from 'react';
import logoAr from '@/assets/brand/logo-ar.webp';
import logoEn from '@/assets/brand/logo-en.webp';
import { Link } from '@/i18n/navigation';

export default function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  if (!isLocale(locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const t = useTranslations('Home');
  const otherLocale: Locale = locale === 'ar' ? 'en' : 'ar';

  return (
    <main className="home">
      <h1 className="brand-logo">
        <Image
          src={locale === 'ar' ? logoAr : logoEn}
          alt={t('title')}
          width={240}
          priority
          unoptimized
        />
      </h1>
      <p>{t('subtitle')}</p>
      <p className="muted">{t('status')}</p>
      <Link href="/" locale={otherLocale}>
        {t('switchLocale')}
      </Link>
    </main>
  );
}
