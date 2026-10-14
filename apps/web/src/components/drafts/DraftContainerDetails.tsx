'use client';

import type { DraftContainer } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { can, useMe } from '../StaffShell';

/**
 * The open container a booking draft goes in, with what approving it does there. `id` is the
 * container the draft names; `container` is null when the user may not see it. Its number links to
 * the container page only for those who may open it (Sales may book into a container, not view it).
 */
export function DraftContainerDetails({
  id,
  container,
}: {
  id: string | null | undefined;
  container: DraftContainer | null;
}) {
  const t = useTranslations('Drafts');
  const me = useMe();
  if (!id) return null;
  return (
    <>
      <dt>{t('container')}</dt>
      <dd>
        {container ? (
          <>
            {can(me, 'consolidation:view') ? (
              <Link href={`/consolidations/${container.id}`} dir="ltr">
                {container.number}
              </Link>
            ) : (
              <span dir="ltr">{container.number}</span>
            )}
            <span dir="ltr">
              {' · '}
              {container.containerTypeCode}
              {container.containerNumber ? ` · ${container.containerNumber}` : ''}
              {container.etd ? ` · ETD ${container.etd}` : ''}
            </span>
          </>
        ) : (
          <span className="muted">{t('containerHidden')}</span>
        )}
        <p className="muted">{t('containerHint')}</p>
      </dd>
    </>
  );
}
