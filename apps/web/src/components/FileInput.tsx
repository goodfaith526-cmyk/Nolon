'use client';

import { useTranslations } from 'next-intl';
import { type InputHTMLAttributes, useEffect, useRef, useState } from 'react';

/**
 * A file picker that speaks the page's language (screen review 2026-11-06): the browser's own
 * "Choose file / No file chosen" follows the browser's language, not the page's. The real input
 * stays in the form (name, required, accept, multiple), only hidden from sight; place this inside
 * a <label> so a click anywhere on it opens the picker.
 */
export function FileInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>,
) {
  const t = useTranslations('Common');
  const ref = useRef<HTMLInputElement>(null);
  const [names, setNames] = useState<string[]>([]);

  // A form reset clears the input; clear the shown names with it.
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const clear = () => setNames([]);
    form.addEventListener('reset', clear);
    return () => form.removeEventListener('reset', clear);
  }, []);

  return (
    <span className="file-input">
      <input
        {...props}
        ref={ref}
        type="file"
        className="visually-hidden"
        onChange={(e) => {
          setNames(Array.from(e.currentTarget.files ?? [], (f) => f.name));
          props.onChange?.(e);
        }}
      />
      <span className="button small" aria-hidden="true">
        {props.multiple ? t('chooseFiles') : t('chooseFile')}
      </span>
      <span className="file-input-name muted">
        {names.length === 0
          ? t('noFileChosen')
          : names.length === 1
            ? names[0]
            : t('filesChosen', { count: names.length })}
      </span>
    </span>
  );
}
