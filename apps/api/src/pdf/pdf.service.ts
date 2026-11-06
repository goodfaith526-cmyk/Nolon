import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../config/env.js';

/** Plan 14-3 (plan 09 section 7): limits of one render. */
export const PDF_LIMITS = {
  concurrent: 2,
  /** Renders allowed to wait for a slot; one more is refused at once as FAILED (F209-3). */
  queued: 10,
  timeoutMs: 20_000,
  htmlBytes: 512 * 1024,
  pdfBytes: 5 * 1024 * 1024,
} as const;

/** Why a render gave no PDF: no renderer configured, or the renderer failed. */
export class PdfUnavailableError extends Error {
  constructor(readonly reason: 'NOT_CONFIGURED' | 'FAILED') {
    super(`PDF ${reason}`);
  }
}

/**
 * Renders self-contained HTML to PDF with Gotenberg (Chromium in its own container, internal
 * network only, external fetches denied). At most 2 renders at a time and 10 waiting (more are
 * refused at once); each has a 20-second
 * timeout; HTML over 512 KB is refused; an answer over 5 MB or not starting with %PDF- is a
 * failure. Nothing is stored.
 */
@Injectable()
export class PdfService {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  get configured(): boolean {
    return Boolean(this.env.PDF_RENDERER_URL);
  }

  async render(html: string): Promise<Buffer> {
    const base = this.env.PDF_RENDERER_URL;
    if (!base) throw new PdfUnavailableError('NOT_CONFIGURED');
    if (Buffer.byteLength(html, 'utf8') > PDF_LIMITS.htmlBytes) {
      throw new PdfUnavailableError('FAILED');
    }
    await this.acquire();
    try {
      const form = new FormData();
      form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
      form.append('preferCssPageSize', 'true');
      form.append('printBackground', 'true');
      let response: Response;
      try {
        response = await fetch(`${base.replace(/\/+$/, '')}/forms/chromium/convert/html`, {
          method: 'POST',
          body: form,
          redirect: 'error',
          signal: AbortSignal.timeout(PDF_LIMITS.timeoutMs),
        });
      } catch (error) {
        Logger.warn(`PDF renderer unreachable (${(error as Error).name})`, 'PdfService');
        throw new PdfUnavailableError('FAILED');
      }
      const length = Number(response.headers.get('content-length') ?? '0');
      if (!response.ok || length > PDF_LIMITS.pdfBytes) {
        await response.body?.cancel().catch(() => undefined);
        Logger.warn(`PDF renderer answered ${response.status}`, 'PdfService');
        throw new PdfUnavailableError('FAILED');
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (
        bytes.byteLength > PDF_LIMITS.pdfBytes ||
        bytes.subarray(0, 5).toString('latin1') !== '%PDF-'
      ) {
        throw new PdfUnavailableError('FAILED');
      }
      return bytes;
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.running < PDF_LIMITS.concurrent) {
      this.running += 1;
      return;
    }
    if (this.waiting.length >= PDF_LIMITS.queued) throw new PdfUnavailableError('FAILED');
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }
}
