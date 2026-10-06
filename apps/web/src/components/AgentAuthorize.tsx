'use client';

import type { AgentAuthorizeResponse } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useFailureText } from './commercial/Notice';

interface Props {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

/**
 * Asks the API for a one-time code for the assistant and follows the address the API returns
 * (the assistant's registered address, with the code). No token is ever put in a URL.
 */
export function AgentAuthorize(props: Props) {
  const t = useTranslations('AgentAuthorize');
  const failure = useFailureText();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<AgentAuthorizeResponse>('/agent-auth/authorize', {
      method: 'POST',
      body: {
        clientId: props.clientId,
        redirectUri: props.redirectUri,
        state: props.state,
        codeChallenge: props.codeChallenge,
        codeChallengeMethod: props.codeChallengeMethod,
      },
    })
      .then(({ redirectTo }) => window.location.replace(redirectTo))
      .catch((e: unknown) => setError(failure(e)));
  }, [props, failure]);

  return (
    <section className="stack">
      <h1>{t('title')}</h1>
      {error ? (
        <p className="error" role="status">
          {t('failed')} {error}
        </p>
      ) : (
        <p className="muted">{t('connecting')}</p>
      )}
    </section>
  );
}
