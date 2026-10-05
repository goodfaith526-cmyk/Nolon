'use client';

import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  type ImportFileErrorBody,
  type ImportIssueDto,
  type ImportKind,
  type ImportPreviewDto,
  type ImportResultDto,
  type ImportRowsInvalidBody,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { can, useMe } from '../StaffShell';
import { Notice, type NoticeState } from './Notice';

/** What an import call answered: a body to show, or a refusal with its status and code. */
type Outcome<T> =
  { ok: true; body: T } | { ok: false; status: number; code: string | null; body: unknown };

/** Sends the workbook (and, to commit, the request id); the API checks everything. */
async function send<T>(kind: ImportKind, file: File, requestId?: string): Promise<Outcome<T>> {
  const form = new FormData();
  form.set('file', file);
  if (requestId) form.set('requestId', requestId);
  const res = await fetch(`/api/v1/${kind}/import${requestId ? '' : '/preview'}`, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON (a proxy error page); the status is enough.
  }
  if (res.ok) return { ok: true, body: body as T };
  const code =
    typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string'
      ? body.code
      : null;
  return { ok: false, status: res.status, code, body };
}

/**
 * Excel import of customers or rates: download the template, upload it for a preview (nothing is
 * saved), then confirm to save every row at once. The API validates; this page only shows what it
 * answers, cell by cell.
 */
export function ExcelImport({ kind }: { kind: ImportKind }) {
  const t = useTranslations('Import');
  const tc = useTranslations('Common');
  const locale = useLocale();
  const me = useMe();
  const [file, setFile] = useState<File | null>(null);
  const [requestId, setRequestId] = useState<string>('');
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null);
  const [result, setResult] = useState<ImportResultDto | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [fileColumns, setFileColumns] = useState<string[]>([]);

  const permission = kind === 'customers' ? 'customers:create' : 'rates:create';
  if (!can(me, permission)) return <p className="error">{tc('noAccess')}</p>;

  const column = (key: string | null) => (key ? t(`col_${kind}_${key}`) : '');
  const limits = { mb: IMPORT_MAX_BYTES / (1024 * 1024), rows: IMPORT_MAX_ROWS };

  function refusal(outcome: Extract<Outcome<unknown>, { ok: false }>): string {
    if (outcome.status === 413) return t('fileErr_FILE_TOO_LARGE', limits);
    if (outcome.status === 403) return tc('noAccess');
    if (outcome.code && t.has(`fileErr_${outcome.code}`)) {
      const body = outcome.body as Partial<ImportFileErrorBody>;
      setFileColumns(Array.isArray(body.columns) ? body.columns : []);
      return t(`fileErr_${outcome.code}`, limits);
    }
    return tc('failed');
  }

  async function onPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const chosen = new FormData(event.currentTarget).get('file');
    if (!(chosen instanceof File) || chosen.size === 0) return;
    setPreview(null);
    setResult(null);
    setNotice(null);
    setFileColumns([]);
    if (chosen.size > IMPORT_MAX_BYTES) {
      setNotice({ ok: false, text: t('fileErr_FILE_TOO_LARGE', limits) });
      return;
    }
    setBusy(true);
    try {
      const outcome = await send<ImportPreviewDto>(kind, chosen);
      if (outcome.ok) {
        setFile(chosen);
        // One request id per uploaded file: retrying the import of this file is safe.
        setRequestId(crypto.randomUUID());
        setPreview(outcome.body);
      } else {
        setNotice({ ok: false, text: refusal(outcome) });
      }
    } catch {
      setNotice({ ok: false, text: tc('failed') });
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    if (!file || !preview) return;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await send<ImportResultDto>(kind, file, requestId);
      if (outcome.ok) {
        setResult(outcome.body);
        setPreview(null);
        setFile(null);
      } else if (outcome.status === 422 && outcome.code === 'ROWS_INVALID') {
        // Something changed since the preview (e.g. a duplicate was added meanwhile).
        setPreview((outcome.body as ImportRowsInvalidBody).preview);
        setNotice({ ok: false, text: t('changedSincePreview') });
      } else {
        setNotice({ ok: false, text: refusal(outcome) });
      }
    } catch {
      setNotice({ ok: false, text: tc('failed') });
    } finally {
      setBusy(false);
    }
  }

  const issuesByRow = new Map<number, ImportIssueDto[]>();
  for (const issue of preview?.issues ?? []) {
    issuesByRow.set(issue.row, [...(issuesByRow.get(issue.row) ?? []), issue]);
  }
  const invalid = preview ? preview.totalRows - preview.validRows : 0;
  const shownRows = (preview?.rows ?? []).filter((r) => !onlyErrors || !r.valid);
  const describe = (issue: ImportIssueDto) =>
    issue.otherRow === undefined
      ? t(`err_${issue.code}`)
      : `${t(`err_${issue.code}`)} ${t('sameAsRow', { row: issue.otherRow })}`;

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <Link href={`/${kind}`} className="back-link">
            {t(`back_${kind}`)}
          </Link>
          <h1>{t(`title_${kind}`)}</h1>
          <p className="muted">{t(`intro_${kind}`)}</p>
        </div>
        <div className="actions">
          <a className="button" href={`/api/v1/${kind}/import/template?locale=${locale}`} download>
            {t('downloadTemplate')}
          </a>
        </div>
      </div>

      <ol className="card stack">
        <li>{t('step1')}</li>
        <li>{t('step2', limits)}</li>
        <li>{t('step3')}</li>
      </ol>

      <form className="card row" onSubmit={(e) => void onPreview(e)}>
        <label className="field">
          {t('chooseFile')}
          <input
            name="file"
            type="file"
            required
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy && !preview ? t('checking') : t('check')}
        </button>
      </form>

      <Notice notice={notice} />
      {fileColumns.length > 0 && (
        <p className="error" dir="auto">
          {fileColumns.join(' · ')}
        </p>
      )}

      {result && (
        <p className="success" role="status">
          {result.replayed
            ? t('alreadyImported', { count: result.created })
            : t(`imported_${kind}`, { count: result.created })}{' '}
          <Link href={`/${kind}`}>{t(`open_${kind}`)}</Link>
        </p>
      )}

      {preview && (
        <>
          <div className="row">
            <p className={invalid === 0 ? 'success' : 'error'} role="status">
              {t('summary', { total: preview.totalRows, valid: preview.validRows, invalid })}{' '}
              {invalid === 0 ? t('readyToImport') : t('fixAndUpload')}
            </p>
            <div className="actions">
              <label className="checks">
                <input
                  type="checkbox"
                  checked={onlyErrors}
                  onChange={(e) => setOnlyErrors(e.target.checked)}
                />
                {t('onlyErrors')}
              </label>
              <button
                type="button"
                className="primary"
                disabled={busy || invalid > 0}
                onClick={() => void onConfirm()}
              >
                {busy ? t('importing') : t('confirm', { count: preview.totalRows })}
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('row')}</th>
                  <th>{t('problems')}</th>
                  {preview.columns.map((key) => (
                    <th key={key}>{column(key)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownRows.map((r) => {
                  const issues = issuesByRow.get(r.row) ?? [];
                  const bad = new Set(issues.map((i) => i.column));
                  return (
                    <tr key={r.row}>
                      <td dir="ltr">{r.row}</td>
                      <td>
                        {issues.length === 0 ? (
                          <span className="badge badge-ok">{t('ok')}</span>
                        ) : (
                          <ul className="error">
                            {issues.map((issue, i) => (
                              <li key={i}>
                                {issue.column ? <strong>{column(issue.column)}: </strong> : null}
                                {describe(issue)}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      {preview.columns.map((key) => (
                        <td key={key} className={bad.has(key) ? 'error' : undefined} dir="auto">
                          {r.values[key] ?? ''}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
