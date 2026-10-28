'use client';

import { COUNTRY_CODES } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';

/** A country's name in the reader's language; the bare code when the browser has none. */
export function useCountryName(): (code: string) => string {
  const locale = useLocale();
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      names = null;
    }
    return (code: string) => names?.of(code) ?? code;
  }, [locale]);
}

/**
 * Country picker that stores the ISO code. Countries already used by the master locations come
 * first; the rest follow by name. A native select: typing a name jumps to it, and the browser's
 * saved personal details are never offered for it.
 */
export function CountrySelect({
  name,
  locations,
  value,
  onChange,
  required = false,
  disabled = false,
  id,
}: {
  name: string;
  /** The locations the form already loaded: their countries come first. */
  locations: readonly { countryCode: string }[] | undefined;
  value: string;
  onChange: (code: string) => void;
  required?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const t = useTranslations('Common');
  const countryName = useCountryName();
  const { used, rest } = useMemo(() => {
    const byName = (a: string, b: string) => countryName(a).localeCompare(countryName(b));
    const inUse = new Set((locations ?? []).map((l) => l.countryCode));
    const all = new Set<string>(COUNTRY_CODES);
    // A stored code outside the list still shows, so editing never drops it.
    if (value) all.add(value);
    return {
      used: [...all].filter((c) => inUse.has(c)).sort(byName),
      rest: [...all].filter((c) => !inUse.has(c)).sort(byName),
    };
  }, [locations, value, countryName]);
  const option = (c: string) => (
    <option key={c} value={c}>
      {countryName(c)} ({c})
    </option>
  );
  return (
    <select
      id={id}
      name={name}
      required={required}
      disabled={disabled}
      autoComplete="off"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{t('chooseCountry')}</option>
      {used.length > 0 ? (
        <>
          <optgroup label={t('countriesInUse')}>{used.map(option)}</optgroup>
          <optgroup label={t('allCountries')}>{rest.map(option)}</optgroup>
        </>
      ) : (
        rest.map(option)
      )}
    </select>
  );
}
