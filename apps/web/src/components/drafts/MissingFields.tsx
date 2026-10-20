'use client';

import {
  BOOKING_SERVICES,
  OFFERED_CARGO_TYPES,
  type CarrierDto,
  type CodeNameDto,
  type CustomerSummaryDto,
  type DraftActions,
  type DriverDto,
  type Page,
  RATE_UNITS,
  SHIPPING_MODES,
  type ShipmentSummaryDto,
  type VehicleDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { asciiDigits } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useApiList } from '../finance/reports/ReportKit';
import {
  type MissingPath,
  NEW_LINE_FIELDS,
  type Value,
  newLinePath,
  parsePath,
  patchBody,
} from './missing-fields';

/** The choices a review screen offers for a value of its kind (a warehouse, a status...). */
export type MissingChoices = Record<string, { value: string; label: string }[]>;

/** A draft whose missing values a person can fill in on its review screen. */
interface EditableDraft {
  id: string;
  version: number;
  missingFields: string[];
  actions: DraftActions;
  request: object;
}

/**
 * The values a draft still misses (worked out by NOLON, `missingFields`), highlighted, and a small
 * form to fill them in. Saving sends them to `PATCH <apiPath>/:id` with the version on screen, and
 * shows the draft NOLON answers with (what it still misses, its check); NOLON checks every value.
 */
export function MissingFields<D extends EditableDraft>({
  draft,
  apiPath,
  branchId,
  request,
  missingFields,
  newLineFields = NEW_LINE_FIELDS,
  choices = {},
  suggested = {},
  dependents = {},
  onChanged,
}: {
  draft: D;
  apiPath: string;
  /** The draft's branch: only its vehicles and drivers are offered (NOLON checks them). */
  branchId?: string;
  /** The values as the PATCH body has them, when not `draft.request` (a kind of two parts). */
  request?: object;
  /** The paths this form fills in, when not all of `draft.missingFields`. */
  missingFields?: string[];
  /** The values of a new line, for a draft saved without lines. */
  newLineFields?: readonly string[];
  choices?: MissingChoices;
  /**
   * Values NOLON suggests for missing paths (from a read of the review screen, worked out by the
   * API): filled in when the form opens, shown as suggested, and saved only if the person saves
   * the form. Read once, when the form mounts: the screen remounts it when they change.
   */
  suggested?: Record<string, Value>;
  /**
   * Paths whose suggested value belongs to another value (`warehouseId` → `['packages']`): when
   * the person changes that value, a suggestion they did not change is dropped.
   */
  dependents?: Record<string, readonly string[]>;
  onChanged: (draft: D) => void;
}) {
  const t = useTranslations('Drafts');
  const tf = useTranslations('Fields');
  const tc = useTranslations('Common');
  const failure = useFailureText();
  const [values, setValues] = useState<Record<string, Value>>(() => ({ ...suggested }));
  // The paths the person changed: a value is theirs once they touch it, even when it ends up
  // equal to the suggestion (Codex F97-2).
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const missing = missingFields ?? draft.missingFields;
  if (missing.length === 0) return null;
  const paths = missing.map(parsePath);
  const editable = draft.actions.canEdit;

  const label = (p: MissingPath) => {
    const name = tf.has(p.field) ? tf(p.field) : p.field;
    return p.index === undefined ? name : `${name} (${tc('lineNo', { n: p.index + 1 })})`;
  };
  const set = (path: string, value: Value) => {
    setTouched((all) => new Set(all).add(path));
    setValues((v) => {
      const next = { ...v, [path]: value };
      // A suggestion tied to the value just changed goes, unless the person changed it themselves.
      for (const dependent of dependents[path] ?? []) {
        if (dependent in suggested && !touched.has(dependent)) delete next[dependent];
      }
      return next;
    });
  };
  const isSuggested = (path: string) =>
    path in suggested && !touched.has(path) && values[path] !== undefined;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api<D>(`${apiPath}/${draft.id}`, {
        method: 'PATCH',
        body: {
          ...patchBody(request ?? draft.request, paths, values, newLineFields),
          version: draft.version,
        },
      });
      setValues({});
      setTouched(new Set());
      setNotice({ ok: true, text: t('missingSaved') });
      onChanged(saved);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack missing-fields" role="region" aria-label={t('missingTitle')}>
      <h2>{t('missingTitle')}</h2>
      <p className="muted">{editable ? t('missingHint') : t('missingReadOnly')}</p>
      {editable && Object.keys(suggested).length > 0 && (
        <p className="notice">{t('missingSuggestedHint')}</p>
      )}
      <ul className="missing-list">
        {paths.map((p) => (
          <li key={p.path} className="badge badge-missing">
            {label(p)}
          </li>
        ))}
      </ul>
      {editable && (
        <form className="stack" onSubmit={(e) => void save(e)}>
          {paths.map((p) =>
            p.field === 'lines' && p.list === undefined ? (
              <fieldset key={p.path} className="stack">
                <legend>{t('missingNewLine')}</legend>
                {newLineFields.map((field) => (
                  <MissingControl
                    key={field}
                    field={field}
                    label={tf(field)}
                    path={newLinePath(p, field)}
                    value={values[newLinePath(p, field)]}
                    onChange={set}
                    branchId={branchId}
                    choices={choices}
                  />
                ))}
              </fieldset>
            ) : (
              <MissingControl
                key={p.path}
                field={p.field}
                label={label(p)}
                path={p.path}
                value={values[p.path]}
                onChange={set}
                branchId={branchId}
                choices={choices}
                suggested={isSuggested(p.path)}
              />
            ),
          )}
          <Notice notice={notice} />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t('missingSave')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** One missing value's control: a list from NOLON's master data or fleet, else a typed value. */
function MissingControl({
  field,
  label,
  path,
  value,
  onChange,
  branchId,
  choices,
  suggested = false,
}: {
  field: string;
  label: string;
  path: string;
  value: Value | undefined;
  onChange: (path: string, value: Value) => void;
  branchId?: string;
  choices: MissingChoices;
  /** The value shown is NOLON's suggestion, not changed yet. */
  suggested?: boolean;
}) {
  const t = useTranslations('Drafts');
  const te = useTranslations('Enums');
  const master = useMasterData();
  const localName = useLocalName();
  const text = typeof value === 'string' ? value : '';
  const codes = (list: CodeNameDto[] | undefined) =>
    (list ?? [])
      .filter((c) => c.isActive)
      .map((c) => ({ value: c.code, label: `${c.code} · ${localName(c)}` }));

  let options: { value: string; label: string }[] | null = choices[field] ?? null;
  if (options !== null) {
    // The review screen's own choices for this value.
  } else if (field === 'originLocationId' || field === 'destinationLocationId') {
    options = (master?.locations ?? [])
      .filter((l) => l.isActive)
      .map((l) => ({ value: l.id, label: `${localName(l)} (${l.code})` }));
  } else if (field === 'currency') options = codes(master?.currencies);
  else if (field === 'chargeTypeCode') options = codes(master?.chargeTypes);
  else if (field === 'containerTypeCode') options = codes(master?.containerTypes);
  else if (field === 'mode')
    options = SHIPPING_MODES.map((m) => ({ value: m, label: te(`mode_${m}`) }));
  else if (field === 'cargoType') {
    options = OFFERED_CARGO_TYPES.map((c) => ({ value: c, label: te(`cargo_${c}`) }));
  } else if (field === 'unit') {
    options = RATE_UNITS.map((u) => ({ value: u, label: te(`unit_${u}`) }));
  }

  if (field === 'vehicleId' || field === 'driverId' || field === 'carrierId') {
    return (
      <FleetSelect
        field={field}
        label={label}
        path={path}
        value={text}
        onChange={onChange}
        branchId={branchId}
      />
    );
  }
  if (field === 'shipmentIds' || field === 'shipmentId') {
    return (
      <ShipmentPicker
        label={label}
        path={path}
        value={value}
        onChange={onChange}
        single={field === 'shipmentId'}
      />
    );
  }
  if (field === 'customerId') {
    return <CustomerPicker label={label} path={path} value={text} onChange={onChange} />;
  }
  if (field === 'services') {
    const picked = Array.isArray(value) ? value : [];
    return (
      <fieldset className="field missing-value">
        <legend>{label}</legend>
        {/* Every booking carries the main freight: it is not a choice. */}
        {BOOKING_SERVICES.filter((s) => s !== 'MAIN_FREIGHT').map((s) => (
          <label key={s} className="field inline">
            <input
              type="checkbox"
              checked={picked.includes(s)}
              onChange={(e) =>
                onChange(path, e.target.checked ? [...picked, s] : picked.filter((x) => x !== s))
              }
            />
            <span>{te(`service_${s}`)}</span>
          </label>
        ))}
      </fieldset>
    );
  }
  return (
    <label className="field missing-value">
      <span>{label}</span>
      {options ? (
        <select value={text} onChange={(e) => onChange(path, e.target.value)}>
          <option value="">{t('missingChoose')}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : DATE_FIELDS.has(field) ? (
        <input type="date" value={text} onChange={(e) => onChange(path, e.target.value)} />
      ) : TEXT_FIELDS.has(field) ? (
        <input
          type={field === 'phone' ? 'tel' : 'text'}
          dir={field === 'phone' ? 'ltr' : 'auto'}
          value={text}
          onChange={(e) => onChange(path, e.target.value)}
        />
      ) : (
        <input
          dir="ltr"
          inputMode="decimal"
          value={text}
          onChange={(e) => onChange(path, asciiDigits(e.target.value))}
        />
      )}
      {suggested && <small className="muted">{t('missingSuggested')}</small>}
      {options !== null && options.length === 0 && choices[field] !== undefined && (
        <small className="muted">{t('missingNoChoices')}</small>
      )}
    </label>
  );
}

const DATE_FIELDS = new Set(['validFrom', 'validUntil', 'invoiceDate', 'dueDate', 'receiptDate']);

/** Values typed as words (a name, a phone), not as amounts. */
const TEXT_FIELDS = new Set([
  'name',
  'companyName',
  'phone',
  'whatsapp',
  'email',
  'city',
  'address',
  'description',
  'cargoDescription',
  'partyName',
  'reference',
  'notes',
]);

/** Searches NOLON's customers (those the reviewer sees) and picks one. */
function CustomerPicker({
  label,
  path,
  value,
  onChange,
}: {
  label: string;
  path: string;
  value: string;
  onChange: (path: string, value: Value) => void;
}) {
  const t = useTranslations('Drafts');
  const tc = useTranslations('Common');
  const failure = useFailureText();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setError(null);
    try {
      const page = await api<Page<CustomerSummaryDto>>(
        `/customers?pageSize=20&q=${encodeURIComponent(q)}`,
      );
      setResults(page.items);
    } catch (e) {
      setError(failure(e));
    }
  }

  return (
    <fieldset className="field missing-value">
      <legend>{label}</legend>
      <SearchBox q={q} onQ={setQ} onSearch={() => void search()} label={tc('search')} />
      {error && <p className="error">{error}</p>}
      {results?.length === 0 && <p className="muted">{t('missingNoCustomers')}</p>}
      {(results ?? []).map((c) => (
        <label key={c.id} className="field inline">
          <input
            type="radio"
            name={path}
            checked={value === c.id}
            onChange={() => onChange(path, c.id)}
          />
          <span dir="ltr">{c.number}</span>
          <span>{c.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** A search field and its button; Enter searches too. */
function SearchBox({
  q,
  onQ,
  onSearch,
  label,
}: {
  q: string;
  onQ: (q: string) => void;
  onSearch: () => void;
  label: string;
}) {
  return (
    <div className="line">
      <label className="field grow">
        <span>{label}</span>
        <input
          type="search"
          value={q}
          onChange={(e) => onQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSearch();
            }
          }}
        />
      </label>
      <button type="button" onClick={onSearch}>
        {label}
      </button>
    </div>
  );
}

/** The active vehicles, drivers or carriers NOLON lists for the reviewer, of the draft's branch. */
function FleetSelect({
  field,
  label,
  path,
  value,
  onChange,
  branchId,
}: {
  field: 'vehicleId' | 'driverId' | 'carrierId';
  label: string;
  path: string;
  value: string;
  onChange: (path: string, value: Value) => void;
  branchId?: string;
}) {
  const t = useTranslations('Drafts');
  const vehicles = useApiList<VehicleDto>('/transport/vehicles', field === 'vehicleId');
  const drivers = useApiList<DriverDto>('/transport/drivers', field === 'driverId');
  const carriers = useApiList<CarrierDto>('/transport/carriers', field === 'carrierId');
  const inBranch = (item: { branchId: string }) =>
    branchId === undefined || item.branchId === branchId;
  const options =
    field === 'vehicleId'
      ? (vehicles ?? []).filter((v) => v.isActive && inBranch(v)).map((v) => [v.id, v.plateNumber])
      : field === 'driverId'
        ? (drivers ?? []).filter((d) => d.isActive && inBranch(d)).map((d) => [d.id, d.name])
        : (carriers ?? []).filter((c) => c.isActive).map((c) => [c.id, c.name]);
  return (
    <label className="field missing-value">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(path, e.target.value)}>
        <option value="">{t('missingChoose')}</option>
        {options.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Searches NOLON's shipments (those the reviewer sees) and picks the trip's shipments, or one
 * shipment (`single`: a release's, an invoice's...).
 */
function ShipmentPicker({
  label,
  path,
  value,
  onChange,
  single = false,
}: {
  label: string;
  path: string;
  value: Value | undefined;
  onChange: (path: string, value: Value) => void;
  single?: boolean;
}) {
  const t = useTranslations('Drafts');
  const tc = useTranslations('Common');
  const failure = useFailureText();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ShipmentSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picked = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];

  async function search() {
    setError(null);
    try {
      const page = await api<Page<ShipmentSummaryDto>>(
        `/shipments?pageSize=20&q=${encodeURIComponent(q)}`,
      );
      setResults(page.items);
    } catch (e) {
      setError(failure(e));
    }
  }

  return (
    <fieldset className="field missing-value">
      <legend>{label}</legend>
      <SearchBox q={q} onQ={setQ} onSearch={() => void search()} label={tc('search')} />
      {error && <p className="error">{error}</p>}
      {results?.length === 0 && <p className="muted">{t('missingNoShipments')}</p>}
      {(results ?? []).map((s) => (
        <label key={s.id} className="field inline">
          <input
            type={single ? 'radio' : 'checkbox'}
            name={path}
            checked={picked.includes(s.id)}
            onChange={(e) =>
              onChange(
                path,
                single
                  ? s.id
                  : e.target.checked
                    ? [...picked, s.id]
                    : picked.filter((x) => x !== s.id),
              )
            }
          />
          <span dir="ltr">{s.number}</span>
          <span>{s.customerName}</span>
        </label>
      ))}
    </fieldset>
  );
}
