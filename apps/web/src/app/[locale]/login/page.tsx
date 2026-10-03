import { isLocale } from '@nolon/shared';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { use } from 'react';
import { LoginForm } from '@/components/LoginForm';

export default function LoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  return <LoginForm />;
}
