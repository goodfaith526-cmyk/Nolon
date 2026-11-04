'use client';

import type { AuthMeResponse } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useLocalName } from '@/lib/master-data';

type MyBranch = AuthMeResponse['branches'][number];

/**
 * Plan 09f: the branch a new document for a customer is written in, since a customer is of no
 * branch. Shown only to a user who writes in more than one branch; the first is chosen already.
 */
export function WorkBranchField({
  branches,
  value,
  onChange,
}: {
  branches: readonly MyBranch[];
  value: string;
  onChange: (id: string) => void;
}) {
  const t = useTranslations('Common');
  const name = useLocalName();
  if (branches.length <= 1) return null;
  return (
    <label className="field">
      {t('workBranch')}
      <select name="branchId" value={value} onChange={(e) => onChange(e.target.value)}>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {name(b)}
          </option>
        ))}
      </select>
    </label>
  );
}
