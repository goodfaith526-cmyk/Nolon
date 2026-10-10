'use client';

import {
  GOODS_CONDITIONS,
  GRN_DRAFT_LINE_FIELDS,
  XLSX_CONTENT_TYPE,
  type GoodsCondition,
  type GrnDraftApproveRequest,
  type GrnDraftDto,
  type GrnDraftFieldMeta,
  type GrnDraftLineField,
  type GrnDraftSummaryDto,
  type GrnDraftUpdateRequest,
  type SheetPreviewDto,
  type ShipmentDocumentDto,
  type WarehouseDto,
  type WarehouseReceiptStatus,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';

/** What the API accepts for weights and cbm (Decimal(12,3)) and quantities (Decimal(14,3)). */
const KG_PATTERN = '\\d{1,9}(\\.\\d{1,3})?';
const QTY_PATTERN = '\\d{1,11}(\\.\\d{1,3})?';

const TEXT_FIELDS = new Set<GrnDraftLineField>(['marks', 'description', 'packageType', 'unit']);
const MAX_LENGTH: Partial<Record<GrnDraftLineField, number>> = {
  marks: 200,
  description: 500,
  packageType: 50,
  unit: 20,
};

type LineValues = Record<GrnDraftLineField, string>;

interface EditLine {
  /** The line it was on the draft; undefined for a line added here. */
  lineNo?: number;
  values: LineValues;
  /** The values as loaded, to show which ones a person changed. */
  loaded?: LineValues;
  fields: Partial<Record<GrnDraftLineField, GrnDraftFieldMeta>>;
  sourcePage: number | null;
  sourceRow: number | null;
}

function emptyValues(): LineValues {
  return Object.fromEntries(GRN_DRAFT_LINE_FIELDS.map((f) => [f, ''])) as LineValues;
}

function toEdit(draft: GrnDraftDto): EditLine[] {
  return draft.lines.map((line) => {
    const values = Object.fromEntries(
      GRN_DRAFT_LINE_FIELDS.map((f) => [f, line[f] === null ? '' : String(line[f])]),
    ) as LineValues;
    return {
      lineNo: line.lineNo,
      values,
      loaded: { ...values },
      fields: line.fields,
      sourcePage: line.sourcePage,
      sourceRow: line.sourceRow,
    };
  });
}

/** CSS class of a cell: who filled it and what code could check about it. */
function cellClass(line: EditLine, f: GrnDraftLineField): string {
  if (line.loaded?.[f] !== line.values[f] || !line.loaded) {
    return line.values[f] ? 'grn-cell grn-staff' : 'grn-cell';
  }
  const meta = line.fields[f];
  if (!meta) return 'grn-cell';
  if (meta.filledBy === 'STAFF') return 'grn-cell grn-staff';
  return `grn-cell grn-ai grn-${(meta.match ?? 'UNVERIFIED').toLowerCase()}`;
}

function updateBody(version: number, lines: EditLine[]): GrnDraftUpdateRequest {
  return {
    version,
    lines: lines.map((line) => {
      const v = line.values;
      const text = (f: GrnDraftLineField) => v[f].trim() || null;
      return {
        ...(line.lineNo === undefined ? {} : { lineNo: line.lineNo }),
        marks: text('marks'),
        description: text('description'),
        packageCount: v.packageCount.trim() ? Number.parseInt(v.packageCount, 10) : null,
        packageType: text('packageType'),
        quantity: text('quantity'),
        unit: text('unit'),
        grossKg: text('grossKg'),
        netKg: text('netKg'),
        cbm: text('cbm'),
      };
    }),
  };
}

/** datetime-local value (local time, no zone) to an ISO timestamp with offset. */
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Draft GRNs the assistant proposed from the shipment's packing lists. A person compares each
 * draft with its source file, corrects the lines, and approves it (which records the GRN) or
 * rejects it. The API decides what is allowed and checks every rule.
 */
export function GrnDrafts({
  shipmentId,
  warehouses,
  receiptStatuses,
  defaultReceiptStatus,
  onApproved,
}: {
  shipmentId: string;
  warehouses: WarehouseDto[];
  receiptStatuses: WarehouseReceiptStatus[];
  defaultReceiptStatus: WarehouseReceiptStatus | null;
  onApproved: () => void;
}) {
  const t = useTranslations('GrnDrafts');
  const locale = useLocale();
  const failure = useFailureText();
  const [drafts, setDrafts] = useState<GrnDraftSummaryDto[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(() => {
    api<GrnDraftSummaryDto[]>(`/shipments/${shipmentId}/grn-drafts`)
      .then(setDrafts)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [shipmentId, failure]);
  useEffect(load, [load]);

  if (drafts.length === 0 && !notice) return null;
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="card stack grn-drafts">
      <h3>{t('title')}</h3>
      <p className="muted">{t('hint')}</p>
      <Notice notice={notice} />
      <table>
        <thead>
          <tr>
            <th>{t('proposedAt')}</th>
            <th>{t('status')}</th>
            <th>{t('lines')}</th>
            <th>{t('packages')}</th>
            <th>{t('warnings')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {drafts.map((d) => (
            <tr key={d.id}>
              <td>{dateTime.format(new Date(d.createdAt))}</td>
              <td>
                <span className={`badge badge-grn-draft badge-${d.status}`}>
                  {t(`status_${d.status}`)}
                </span>
              </td>
              <td>{d.lineCount}</td>
              <td dir="ltr">{d.lineTotals.packages ?? '—'}</td>
              <td>{d.warnings.length > 0 ? d.warnings.length : '—'}</td>
              <td>
                <button
                  type="button"
                  className="small"
                  onClick={() => setOpenId(openId === d.id ? null : d.id)}
                >
                  {openId === d.id ? t('close') : t('review')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {openId && (
        <GrnDraftReview
          key={openId}
          shipmentId={shipmentId}
          draftId={openId}
          warehouses={warehouses}
          receiptStatuses={receiptStatuses}
          defaultReceiptStatus={defaultReceiptStatus}
          onChanged={(approved) => {
            load();
            if (approved) onApproved();
          }}
        />
      )}
    </section>
  );
}

function GrnDraftReview({
  shipmentId,
  draftId,
  warehouses,
  receiptStatuses,
  defaultReceiptStatus,
  onChanged,
}: {
  shipmentId: string;
  draftId: string;
  warehouses: WarehouseDto[];
  receiptStatuses: WarehouseReceiptStatus[];
  defaultReceiptStatus: WarehouseReceiptStatus | null;
  onChanged: (approved: boolean) => void;
}) {
  const t = useTranslations('GrnDrafts');
  const tw = useTranslations('Warehouse');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const localName = useLocalName();
  const failure = useFailureText();
  const [draft, setDraft] = useState<GrnDraftDto | null>(null);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [source, setSource] = useState<ShipmentDocumentDto | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [receiptWarehouse, setReceiptWarehouse] = useState('');
  const path = `/shipments/${shipmentId}/grn-drafts/${draftId}`;

  const show = useCallback((d: GrnDraftDto) => {
    setDraft(d);
    setLines(toEdit(d));
  }, []);

  useEffect(() => {
    api<GrnDraftDto>(path)
      .then(show)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [path, show, failure]);

  useEffect(() => {
    if (!draft) return;
    api<ShipmentDocumentDto[]>(`/shipments/${shipmentId}/documents`)
      .then((docs) => setSource(docs.find((d) => d.id === draft.documentId) ?? null))
      .catch(() => setSource(null));
  }, [shipmentId, draft]);

  if (!draft) {
    return notice ? <Notice notice={notice} /> : <p className="empty">{tc('loading')}</p>;
  }

  const editable = draft.actions.canEdit;
  const dirty =
    lines.some(
      (l) => !l.loaded || GRN_DRAFT_LINE_FIELDS.some((f) => l.loaded?.[f] !== l.values[f]),
    ) || lines.length !== draft.lines.length;
  const activeWarehouses = warehouses.filter((w) => w.isActive);
  const selectedWarehouse =
    activeWarehouses.find((w) => w.id === receiptWarehouse) ?? activeWarehouses[0];

  async function call(run: () => Promise<GrnDraftDto>, success: (d: GrnDraftDto) => string) {
    setBusy(true);
    setNotice(null);
    try {
      const d = await run();
      show(d);
      setNotice({ ok: true, text: success(d) });
      onChanged(d.status === 'APPROVED');
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  function setValue(index: number, f: GrnDraftLineField, value: string) {
    setLines((current) =>
      current.map((l, i) => (i === index ? { ...l, values: { ...l.values, [f]: value } } : l)),
    );
  }

  function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    void call(
      () => api<GrnDraftDto>(path, { method: 'PATCH', body: updateBody(draft.version, lines) }),
      () => t('saved'),
    );
  }

  function onApprove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const f = new FormData(event.currentTarget);
    const body: GrnDraftApproveRequest = {
      version: draft.version,
      warehouseId: field(f, 'warehouseId'),
      storageLocationId: field(f, 'storageLocationId') || null,
      packages: Number.parseInt(field(f, 'packages'), 10),
      weightKg: field(f, 'weightKg').trim() || null,
      condition: field(f, 'condition') as GoodsCondition,
      partyName: field(f, 'partyName').trim() || null,
      note: field(f, 'note').trim() || null,
      occurredAt: toIso(field(f, 'occurredAt')),
      shipmentStatus: (field(f, 'shipmentStatus') || null) as WarehouseReceiptStatus | null,
      extraPackagesConfirmed: f.get('extraPackagesConfirmed') === 'on',
    };
    void call(
      () => api<GrnDraftDto>(`${path}/approve`, { method: 'POST', body }),
      (d) => t('approvedNotice', { number: d.movementNumber ?? '' }),
    );
  }

  function onReject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const reason = field(new FormData(event.currentTarget), 'reason').trim();
    void call(
      () =>
        api<GrnDraftDto>(`${path}/reject`, {
          method: 'POST',
          body: { version: draft.version, reason },
        }),
      () => t('rejectedNotice'),
    );
  }

  const totalsRow = (key: 'statedTotals' | 'lineTotals') => {
    const totals = draft[key];
    return (
      <tr>
        <th scope="row">{t(key)}</th>
        <td dir="ltr">{totals.packages ?? '—'}</td>
        <td dir="ltr">{totals.grossKg ?? '—'}</td>
        <td dir="ltr">{totals.netKg ?? '—'}</td>
        <td dir="ltr">{totals.cbm ?? '—'}</td>
      </tr>
    );
  };

  return (
    <div className="grn-review">
      <div className="grn-source stack">
        <h4>{t('source')}</h4>
        <SourceView shipmentId={shipmentId} source={source} lines={lines} />
      </div>

      <div className="grn-draft stack">
        <Notice notice={notice} />
        <p>
          <span className={`badge badge-grn-draft badge-${draft.status}`}>
            {t(`status_${draft.status}`)}
          </span>{' '}
          <span className="muted">
            {t('proposedFor', { name: `\u2068${draft.createdByName}\u2069` })}
          </span>
        </p>
        {draft.status === 'APPROVED' && (
          <p className="success">
            {t('approvedBy', {
              name: draft.decidedByName ?? '',
              number: draft.movementNumber ?? '',
            })}
          </p>
        )}
        {draft.status === 'REJECTED' && (
          <p className="error">
            {t('rejectedBy', { name: draft.decidedByName ?? '', reason: draft.rejectReason ?? '' })}
          </p>
        )}
        {draft.warnings.length > 0 && (
          <ul className="grn-warnings">
            {draft.warnings.map((w) => (
              <li key={w}>{t(`warning_${w}`)}</li>
            ))}
          </ul>
        )}

        <ul className="grn-legend" aria-label={t('legend')}>
          <li className="grn-cell grn-ai grn-matched">{t('legendMatched')}</li>
          <li className="grn-cell grn-ai grn-unverified">{t('legendUnverified')}</li>
          <li className="grn-cell grn-ai grn-mismatch">{t('legendMismatch')}</li>
          <li className="grn-cell grn-staff">{t('legendStaff')}</li>
        </ul>

        <table>
          <thead>
            <tr>
              <th />
              <th>{t('packages')}</th>
              <th>{t('field_grossKg')}</th>
              <th>{t('field_netKg')}</th>
              <th>{t('field_cbm')}</th>
            </tr>
          </thead>
          <tbody>
            {totalsRow('statedTotals')}
            {totalsRow('lineTotals')}
          </tbody>
        </table>

        <form className="stack" onSubmit={onSave}>
          <div className="table-scroll">
            <table className="grn-lines">
              <thead>
                <tr>
                  <th>#</th>
                  {GRN_DRAFT_LINE_FIELDS.map((f) => (
                    <th key={f}>{t(`field_${f}`)}</th>
                  ))}
                  <th>{t('sourceAt')}</th>
                  {editable && <th />}
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr key={`${line.lineNo ?? 'new'}-${i}`}>
                    <td>{i + 1}</td>
                    {GRN_DRAFT_LINE_FIELDS.map((f) => (
                      <td key={f} className={`${cellClass(line, f)} grn-f-${f}`}>
                        {editable ? (
                          <input
                            aria-label={t(`field_${f}`)}
                            value={line.values[f]}
                            onChange={(e) => setValue(i, f, e.target.value)}
                            {...(TEXT_FIELDS.has(f)
                              ? { maxLength: MAX_LENGTH[f] }
                              : f === 'packageCount'
                                ? { type: 'number', min: 0, step: 1, dir: 'ltr' }
                                : {
                                    inputMode: 'decimal' as const,
                                    dir: 'ltr',
                                    pattern: f === 'quantity' ? QTY_PATTERN : KG_PATTERN,
                                  })}
                          />
                        ) : (
                          // Text read from a document is shown as text, never as markup or links.
                          <span dir={TEXT_FIELDS.has(f) ? 'auto' : 'ltr'}>
                            {line.values[f] || '—'}
                          </span>
                        )}
                      </td>
                    ))}
                    <td className="muted" dir="ltr">
                      {line.sourceRow
                        ? t('row', { n: line.sourceRow })
                        : line.sourcePage
                          ? t('page', { n: line.sourcePage })
                          : '—'}
                    </td>
                    {editable && (
                      <td>
                        <button
                          type="button"
                          className="small"
                          disabled={lines.length <= 1}
                          onClick={() => setLines((c) => c.filter((_, j) => j !== i))}
                        >
                          {t('removeLine')}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {editable && (
            <div className="actions">
              <button
                type="button"
                onClick={() =>
                  setLines((c) => [
                    ...c,
                    { values: emptyValues(), fields: {}, sourcePage: null, sourceRow: null },
                  ])
                }
              >
                {t('addLine')}
              </button>
              <button type="submit" className="primary" disabled={busy || !dirty}>
                {t('save')}
              </button>
            </div>
          )}
        </form>

        {draft.actions.canDecide && (
          <>
            {dirty ? (
              <p className="muted">{t('saveBeforeDeciding')}</p>
            ) : activeWarehouses.length === 0 || !selectedWarehouse ? (
              <p className="muted">{tw('noWarehouses')}</p>
            ) : (
              <form className="card stack" onSubmit={onApprove}>
                <h4>{t('approveTitle')}</h4>
                <p className="muted">{t('approveHint')}</p>
                <div className="grid">
                  <label className="field">
                    <span>{tw('warehouse')}</span>
                    <select
                      name="warehouseId"
                      required
                      value={selectedWarehouse.id}
                      onChange={(e) => setReceiptWarehouse(e.target.value)}
                    >
                      {activeWarehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.code} · {localName(w)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{tw('storageLocation')}</span>
                    <select name="storageLocationId" defaultValue="" key={selectedWarehouse.id}>
                      <option value="">—</option>
                      {selectedWarehouse.storageLocations
                        .filter((l) => l.isActive)
                        .map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.code}
                            {l.name ? ` · ${l.name}` : ''}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{tw('packages')}</span>
                    <input
                      name="packages"
                      type="number"
                      required
                      min={1}
                      step={1}
                      dir="ltr"
                      defaultValue={draft.lineTotals.packages ?? ''}
                    />
                  </label>
                  <label className="field">
                    <span>{tw('weightKg')}</span>
                    <input
                      name="weightKg"
                      inputMode="decimal"
                      dir="ltr"
                      pattern={KG_PATTERN}
                      defaultValue={draft.lineTotals.grossKg ?? ''}
                    />
                  </label>
                  <label className="field">
                    <span>{tw('condition')}</span>
                    <select name="condition" required defaultValue="GOOD">
                      {GOODS_CONDITIONS.map((c) => (
                        <option key={c} value={c}>
                          {te(`condition_${c}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{tw('deliveredBy')}</span>
                    <input name="partyName" maxLength={200} />
                  </label>
                  <label className="field">
                    <span>{tw('occurredAt')}</span>
                    <input name="occurredAt" type="datetime-local" />
                  </label>
                  {receiptStatuses.length > 0 && (
                    <label className="field">
                      <span>{tw('shipmentStatus')}</span>
                      <select name="shipmentStatus" defaultValue={defaultReceiptStatus ?? ''}>
                        <option value="">{tw('keepStatus')}</option>
                        {receiptStatuses.map((s) => (
                          <option key={s} value={s}>
                            {te(`shipment_${s}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <label className="field">
                  <span>{tw('note')}</span>
                  <textarea name="note" maxLength={1000} />
                </label>
                <div className="checks">
                  <label>
                    <input type="checkbox" name="extraPackagesConfirmed" />
                    {t('extraPackagesConfirmed')}
                  </label>
                </div>
                <div className="actions">
                  <button type="submit" className="primary" disabled={busy}>
                    {t('approve')}
                  </button>
                </div>
              </form>
            )}
            <form className="line" onSubmit={onReject}>
              <label className="field">
                <span>{t('rejectReason')}</span>
                <input name="reason" required maxLength={500} />
              </label>
              <button type="submit" disabled={busy}>
                {t('reject')}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The source packing list next to the draft. A PDF or image comes from the preview route (served
 * with its detected type, never as a page); a spreadsheet is shown as text cells, with the rows
 * the draft points at marked.
 */
function SourceView({
  shipmentId,
  source,
  lines,
}: {
  shipmentId: string;
  source: ShipmentDocumentDto | null | undefined;
  lines: EditLine[];
}) {
  const t = useTranslations('GrnDrafts');
  const tc = useTranslations('Common');
  const [sheet, setSheet] = useState<SheetPreviewDto | null | undefined>(undefined);
  const isSheet = source?.contentType === XLSX_CONTENT_TYPE;

  useEffect(() => {
    if (!source || !isSheet) return;
    api<SheetPreviewDto>(`/shipments/${shipmentId}/documents/${source.id}/sheet`)
      .then(setSheet)
      .catch(() => setSheet(null));
  }, [shipmentId, source, isSheet]);

  if (source === undefined) return <p className="empty">{tc('loading')}</p>;
  if (source === null) return <p className="error">{t('sourceGone')}</p>;
  const preview = `/api/v1/shipments/${shipmentId}/documents/${source.id}/preview`;
  const download = `/api/v1/shipments/${shipmentId}/documents/${source.id}/file`;

  let body;
  if (isSheet) {
    const rows = new Set(lines.map((l) => l.sourceRow).filter((r): r is number => r !== null));
    body =
      sheet === undefined ? (
        <p className="empty">{tc('loading')}</p>
      ) : sheet === null ? (
        <p className="error">{t('sheetUnreadable')}</p>
      ) : (
        <div className="table-scroll grn-sheet" dir="ltr">
          <table>
            <tbody>
              {sheet.rows.map((row) => (
                <tr key={row.rowNumber} className={rows.has(row.rowNumber) ? 'grn-row-used' : ''}>
                  <th scope="row" dir="ltr">
                    {row.rowNumber}
                  </th>
                  {row.cells.map((cell, i) => (
                    <td key={i} dir="auto">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {sheet.truncated && <p className="muted">{t('sheetTruncated')}</p>}
        </div>
      );
  } else if (source.contentType === 'application/pdf') {
    body = <iframe className="grn-pdf" src={preview} title={t('source')} />;
  } else {
    // eslint-disable-next-line @next/next/no-img-element -- an API-served document, not a static asset.
    body = <img className="grn-image" src={preview} alt={t('source')} />;
  }
  return (
    <>
      {body}
      <a href={download}>{t('download')}</a>
    </>
  );
}
