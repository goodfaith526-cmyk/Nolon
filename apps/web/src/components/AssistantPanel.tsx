'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { assistantPageUrl } from '@/lib/assistant-page';
import { createScreenHost, screenOf } from '@/lib/assistant-screen';
import { icons } from './Icons';

/**
 * The assistant beside NOLON's pages: a frame of the assistant's staff screen that stays loaded
 * while the staff member moves between pages, and while the panel is closed, so the conversation,
 * its scroll and any unsent text survive. NOLON tells it only the booking or shipment on screen
 * (lib/assistant-screen.ts). The assistant still reaches NOLON only through its API with the staff
 * member's own delegated token, and only proposes drafts that a person approves here.
 */
export function AssistantPanel({
  url,
  pathname,
  open,
  onClose,
}: {
  /** AGENT_ASSISTANT_URL. */
  url: string;
  pathname: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('Shell');
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<ReturnType<typeof createScreenHost> | null>(null);
  const origin = new URL(url).origin;

  useEffect(() => {
    const host = createScreenHost({
      origin,
      win: window,
      frame: () => frameRef.current?.contentWindow ?? null,
      screen: null,
    });
    hostRef.current = host;
    return () => {
      host.stop();
      hostRef.current = null;
    };
  }, [origin]);

  useEffect(() => {
    hostRef.current?.setScreen(screenOf(pathname));
  }, [pathname, origin]);

  return (
    <aside
      id="assistant-panel"
      className="assistant-panel"
      aria-label={t('assistant')}
      hidden={!open}
    >
      <div className="assistant-panel-head">
        <strong>{t('assistant')}</strong>
        <a
          href={assistantPageUrl(url, pathname)}
          target="_blank"
          rel="noopener noreferrer"
          className="button ghost"
        >
          {t('assistantNewTab')}
        </a>
        <button
          type="button"
          className="icon-button"
          aria-label={t('closeAssistant')}
          onClick={onClose}
        >
          {icons.close}
        </button>
      </div>
      <iframe
        ref={frameRef}
        src={url}
        title={t('assistant')}
        className="assistant-panel-frame"
        // The assistant may not navigate NOLON's page; it opens anything else in a new tab.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
        allow="microphone; clipboard-write"
        referrerPolicy="strict-origin"
      />
    </aside>
  );
}
