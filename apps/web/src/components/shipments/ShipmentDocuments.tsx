'use client';

import { MAX_DOCUMENT_BYTES, type ShipmentDocumentDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';

/** Uploads one file with its type; the API checks the content, size and permissions. */
async function uploadDocument(shipmentId: string, form: FormData): Promise<ShipmentDocumentDto> {
  const res = await fetch(`/api/v1/shipments/${shipmentId}/documents`, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return (await res.json()) as ShipmentDocumentDto;
}

export function ShipmentDocuments({ shipmentId }: { shipmentId: string }) {
  const t = useTranslations('Shipments');
  const tc = useTranslations('Common');
  const locale = useLocale();
  const me = useMe();
  const master = useMasterData();
  const localName = useLocalName();
  const failure = useFailureText();
  const [documents, setDocuments] = useState<ShipmentDocumentDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(() => {
    api<ShipmentDocumentDto[]>(`/shipments/${shipmentId}/documents`)
      .then(setDocuments)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [shipmentId, failure]);

  useEffect(load, [load]);

  async function onUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) return;
    if (file.size > MAX_DOCUMENT_BYTES) {
      setNotice({ ok: false, text: t('fileTooLarge') });
      return;
    }
    // The name goes as a text field so Arabic names arrive intact.
    form.set('fileName', file.name);
    if (!field(form, 'note')) form.delete('note');
    setBusy(true);
    setNotice(null);
    try {
      await uploadDocument(shipmentId, form);
      element.reset();
      setNotice({ ok: true, text: t('uploaded') });
      load();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setNotice({
        ok: false,
        text: status === 413 ? t('fileTooLarge') : status === 400 ? t('fileRejected') : failure(e),
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(documentId: string) {
    setNotice(null);
    try {
      await api(`/shipments/${shipmentId}/documents/${documentId}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    }
  }

  const typeName = (code: string) => {
    const type = master?.documentTypes.find((d) => d.code === code);
    return type ? localName(type) : code;
  };
  const size = (bytes: number) =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'kilobyte',
      maximumFractionDigits: 0,
    }).format(Math.max(1, Math.round(bytes / 1024)));
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('documents')}</h2>
      </div>
      <Notice notice={notice} />
      {can(me, 'documents:create') && (
        <form className="line inset" onSubmit={(e) => void onUpload(e)}>
          <label className="field">
            <span>{t('documentType')}</span>
            <select name="typeCode" required>
              {master?.documentTypes
                .filter((d) => d.isActive)
                .map((d) => (
                  <option key={d.code} value={d.code}>
                    {localName(d)}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>{t('file')}</span>
            <input
              name="file"
              type="file"
              required
              accept="application/pdf,image/jpeg,image/png,image/webp"
            />
          </label>
          <label className="field">
            <span>{t('note')}</span>
            <input name="note" maxLength={1000} />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? t('uploading') : t('upload')}
          </button>
        </form>
      )}
      {documents === null ? (
        <p className="empty">{tc('loading')}</p>
      ) : documents.length === 0 ? (
        <p className="empty">{t('noDocuments')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('documentType')}</th>
              <th>{t('file')}</th>
              <th>{t('uploadedBy')}</th>
              {can(me, 'documents:cancel') && <th />}
            </tr>
          </thead>
          <tbody>
            {documents.map((d) => (
              <tr key={d.id}>
                <td>{typeName(d.typeCode)}</td>
                <td>
                  <a href={`/api/v1/shipments/${shipmentId}/documents/${d.id}/file`}>
                    {d.fileName}
                  </a>
                  <div className="muted">
                    {size(d.sizeBytes)}
                    {d.note ? ` · ${d.note}` : ''}
                  </div>
                </td>
                <td>
                  {d.uploadedByName}
                  <div className="muted">{dateTime.format(new Date(d.uploadedAt))}</div>
                </td>
                {can(me, 'documents:cancel') && (
                  <td>
                    <button type="button" onClick={() => void remove(d.id)}>
                      {tc('remove')}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
