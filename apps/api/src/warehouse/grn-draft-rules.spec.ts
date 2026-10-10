import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import {
  canonicalJson,
  draftStatus,
  draftWarnings,
  lineTotals,
  metaAfterEdit,
  metaForAiLine,
  payloadHash,
  reportedWarnings,
  storedValues,
} from './grn-draft-rules.js';

const empty = { packages: null, grossKg: null, netKg: null, cbm: null };

function request(lines: Parameters<typeof storedValues>[0][], sha = 'a'.repeat(64)) {
  return {
    documentId: '00000000-0000-4000-8000-000000000001',
    documentSha256: sha,
    statedTotals: empty,
    warnings: [] as string[],
    lines: lines.map((l) => {
      const values = storedValues(l);
      return { values, sourcePage: 1, sourceRow: null, meta: metaForAiLine(values, undefined) };
    }),
  };
}

describe('GRN draft field metadata', () => {
  it('marks every value the assistant filled as AI, UNVERIFIED unless matched', () => {
    const values = storedValues({ description: 'Shirts', packageCount: 10, grossKg: '120.5' });
    expect(metaForAiLine(values, { description: 'MATCHED', cbm: 'MATCHED' })).toEqual({
      description: { filledBy: 'AI', match: 'MATCHED' },
      packageCount: { filledBy: 'AI', match: 'UNVERIFIED' },
      grossKg: { filledBy: 'AI', match: 'UNVERIFIED' },
    });
  });

  it('keeps the metadata of values left as they were, decimals compared by value', () => {
    const before = storedValues({ description: 'Shirts', grossKg: '120.50', packageCount: 10 });
    const meta = metaForAiLine(before, { description: 'MATCHED', grossKg: 'MATCHED' });
    const after = storedValues({ description: 'Shirts', grossKg: '120.5', packageCount: 12 });
    expect(metaAfterEdit({ values: before, meta }, after)).toEqual({
      description: { filledBy: 'AI', match: 'MATCHED' },
      grossKg: { filledBy: 'AI', match: 'MATCHED' },
      packageCount: { filledBy: 'STAFF', match: null },
    });
  });

  it('gives a new line and an emptied field no AI metadata', () => {
    const after = storedValues({ description: 'Added by hand' });
    expect(metaAfterEdit(undefined, after)).toEqual({
      description: { filledBy: 'STAFF', match: null },
    });
  });
});

describe('GRN draft totals', () => {
  it('adds up the lines in Decimal, null when no line has the value', () => {
    const totals = lineTotals([
      storedValues({ packageCount: 3, grossKg: '0.1', cbm: '1.005' }),
      storedValues({ packageCount: 4, grossKg: '0.2' }),
    ]);
    expect(totals.packages).toBe(7);
    expect(totals.grossKg?.toString()).toBe('0.3');
    expect(totals.netKg).toBeNull();
    expect(totals.cbm?.equals(dec('1.005'))).toBe(true);
  });
});

describe('GRN draft status', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  it('reads an undecided draft past its expiry as EXPIRED', () => {
    expect(draftStatus('DRAFT', new Date('2026-10-09T23:59:59Z'), now)).toBe('EXPIRED');
    expect(draftStatus('DRAFT', new Date('2026-10-10T00:00:01Z'), now)).toBe('DRAFT');
  });
  it('keeps a decision after the expiry', () => {
    expect(draftStatus('APPROVED', new Date('2026-01-01T00:00:00Z'), now)).toBe('APPROVED');
    expect(draftStatus('REJECTED', new Date('2026-01-01T00:00:00Z'), now)).toBe('REJECTED');
  });
});

describe('GRN draft request hash', () => {
  it('sorts keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}',
    );
  });

  it('is the same for the same values written differently', () => {
    const a = payloadHash(request([{ grossKg: '1.50', description: 'x' }]));
    const b = payloadHash(request([{ description: 'x', grossKg: '1.5' }]));
    expect(a).toBe(b);
  });

  it('changes with any line value, the order of lines or the document bytes', () => {
    const base = payloadHash(request([{ description: 'x' }, { description: 'y' }]));
    expect(payloadHash(request([{ description: 'x' }, { description: 'z' }]))).not.toBe(base);
    expect(payloadHash(request([{ description: 'y' }, { description: 'x' }]))).not.toBe(base);
    expect(
      payloadHash(request([{ description: 'x' }, { description: 'y' }], 'b'.repeat(64))),
    ).not.toBe(base);
  });
});

describe('GRN draft warnings', () => {
  const stated = { packages: 10, grossKg: dec('1000'), netKg: null, cbm: dec('2.5') };
  const lines = (...values: Parameters<typeof storedValues>[0][]) => values.map(storedValues);

  it('none when the lines add up to every stated total, decimals compared by value', () => {
    expect(
      draftWarnings(
        [],
        stated,
        lines(
          { packageCount: 6, grossKg: '600.50', cbm: '1.5' },
          { packageCount: 4, grossKg: '399.5', cbm: '1' },
        ),
      ),
    ).toEqual([]);
  });

  it('appears when an edit opens a difference, and a total no line carries differs', () => {
    expect(
      draftWarnings(
        [],
        stated,
        lines({ packageCount: 6, grossKg: '600.5' }, { packageCount: 3, grossKg: '399.5' }),
      ),
    ).toEqual(['TOTAL_PACKAGES_MISMATCH', 'TOTAL_CBM_MISMATCH']);
  });

  it('clears when an edit closes it, whatever was stored or reported before', () => {
    const stored = ['TOTAL_PACKAGES_MISMATCH', 'TOTAL_GROSS_MISMATCH', 'NET_ABOVE_GROSS'];
    expect(
      draftWarnings(stored, { ...stated, cbm: null }, lines({ packageCount: 10, grossKg: '1000' })),
    ).toEqual([]);
  });

  it('flags net above gross on a line or on the totals; keeps what the assistant saw in the file', () => {
    const none = { packages: null, grossKg: null, netKg: null, cbm: null };
    expect(draftWarnings([], none, lines({ grossKg: '10', netKg: '10.001' }))).toEqual([
      'NET_ABOVE_GROSS',
    ]);
    expect(draftWarnings([], none, lines({ grossKg: '10' }, { netKg: '11' }))).toEqual([
      'NET_ABOVE_GROSS',
    ]);
    expect(draftWarnings(['SOURCE_NOT_VERIFIABLE', 'bogus'], none, [])).toEqual([
      'SOURCE_NOT_VERIFIABLE',
    ]);
  });

  it('stores only the warnings about the file from what the assistant reports', () => {
    expect(reportedWarnings(['TOTAL_GROSS_MISMATCH', 'SOURCE_NOT_VERIFIABLE'])).toEqual([
      'SOURCE_NOT_VERIFIABLE',
    ]);
  });
});
