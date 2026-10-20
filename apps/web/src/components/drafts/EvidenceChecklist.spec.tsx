// @vitest-environment jsdom
import type { DraftEvidence } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Group z item 3: the values a reviewer reads at a glance share one tick; every other value keeps
// its own, and the ticks of one draft version never carry over to the next.

const translate = (key: string, values?: Record<string, string>) =>
  values ? `${key}:${Object.values(values).join('|')}` : key;
vi.mock('next-intl', () => ({ useTranslations: () => translate, useLocale: () => 'en' }));

const {
  EvidenceChecklist,
  GROUPED_EVIDENCE_FIELDS,
  confirmedBody,
  isGroupedField,
  useEvidenceTicks,
} = await import('./EvidenceChecklist');

const evidence: DraftEvidence[] = [
  { field: 'originLocationId', quote: 'from Jeddah' },
  { field: 'destinationLocationId', quote: 'to Port Sudan' },
  { field: 'transitDays', quote: '12 days' },
  { field: 'price', quote: '1200' },
  { field: 'currency', quote: 'dollars' },
  { field: 'packagingNote', quote: 'on pallets' },
];
const values = {
  originLocationId: { label: 'Origin', value: 'JED' },
  destinationLocationId: { label: 'Destination', value: 'PZU' },
  transitDays: { label: 'Transit days', value: '12' },
  price: { label: 'Price', value: '1200' },
  currency: { label: 'Currency', value: 'USD' },
};

/** What the approval would send, written where the test can read it. */
let sent: { confirmed: string[] } | null = null;

function Screen({ version, words = evidence }: { version: number; words?: DraftEvidence[] }) {
  const [ticked, setTicked] = useEvidenceTicks(version);
  sent = confirmedBody(words, ticked);
  return (
    <EvidenceChecklist
      evidence={words}
      values={values}
      ticked={ticked}
      onChange={setTicked}
      editable
    />
  );
}

const roots: (() => void)[] = [];
afterEach(() => {
  roots.splice(0).forEach((unmount) => unmount());
  sent = null;
});

function show(version: number) {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  const render = (v: number) => act(() => root.render(<Screen version={v} />));
  render(version);
  roots.push(() => act(() => root.unmount()));
  return { el, render };
}
const box = (el: HTMLElement, id: string) => el.querySelector<HTMLInputElement>(`#${id}`);
const tick = (el: HTMLElement, id: string) => act(() => box(el, id)?.click());

describe('EvidenceChecklist', () => {
  it('classifies only the listed fields as grouped; any other field is ticked on its own', () => {
    expect(GROUPED_EVIDENCE_FIELDS).toEqual([
      'branchId',
      'originLocationId',
      'destinationLocationId',
      'locationId',
      'transitDays',
    ]);
    for (const f of ['price', 'currency', 'quantity', 'weight', 'name', 'phone', 'customerId'])
      expect(isGroupedField(f)).toBe(false);
    expect(isGroupedField('packagingNote')).toBe(false);
    // A line's value is never grouped, even with a grouped field's name.
    expect(isGroupedField('items[0].transitDays')).toBe(false);
  });

  it('one tick confirms the grouped fields only, and names each one it covers', () => {
    const { el } = show(1);
    const group = el.querySelector('label[for="evidence-group"]');
    expect(group?.textContent).toBe('wordsGroup:Origin, Destination, and Transit days');
    // Grouped values have no tick of their own; the others each have one.
    expect(box(el, 'evidence-originLocationId')).toBeNull();
    expect(box(el, 'evidence-transitDays')).toBeNull();
    expect(box(el, 'evidence-price')).not.toBeNull();
    expect(box(el, 'evidence-currency')).not.toBeNull();
    // An unknown field keeps its own tick (fail safe).
    expect(box(el, 'evidence-packagingNote')).not.toBeNull();

    tick(el, 'evidence-group');
    expect(box(el, 'evidence-price')?.checked).toBe(false);
    expect(box(el, 'evidence-currency')?.checked).toBe(false);
    expect(box(el, 'evidence-packagingNote')?.checked).toBe(false);
    expect(sent).toBeNull();
  });

  it('approval waits for every sensitive value, then sends each field as before', () => {
    const { el } = show(1);
    tick(el, 'evidence-group');
    tick(el, 'evidence-price');
    tick(el, 'evidence-currency');
    expect(sent).toBeNull();
    tick(el, 'evidence-packagingNote');
    expect(sent).toEqual({ confirmed: evidence.map((e) => e.field) });
    // Unticking the group takes back only its fields.
    tick(el, 'evidence-group');
    expect(sent).toBeNull();
    expect(box(el, 'evidence-price')?.checked).toBe(true);
  });

  it('drops every tick, the group and each value, when the draft version changes', () => {
    const { el, render } = show(1);
    tick(el, 'evidence-group');
    tick(el, 'evidence-price');
    tick(el, 'evidence-currency');
    tick(el, 'evidence-packagingNote');
    expect(sent).not.toBeNull();
    render(2);
    expect(box(el, 'evidence-group')?.checked).toBe(false);
    expect(box(el, 'evidence-price')?.checked).toBe(false);
    expect(sent).toBeNull();
  });

  it('shows no group tick when no grouped field carries words', () => {
    const el = document.createElement('div');
    const root = createRoot(el);
    act(() => root.render(<Screen version={1} words={[{ field: 'price', quote: '1200' }]} />));
    roots.push(() => act(() => root.unmount()));
    expect(box(el, 'evidence-group')).toBeNull();
    tick(el, 'evidence-price');
    expect(sent).toEqual({ confirmed: ['price'] });
  });
});
