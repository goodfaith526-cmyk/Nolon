import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { asciiDigits } from '@/lib/form';
import { invalidFields, invalidInputText, type InvalidInputWords } from './Notice';

const labels: Record<string, string> = { weightKg: 'Weight (kg)', services: 'Services' };
const words: InvalidInputWords = {
  field: (key) => labels[key] ?? key,
  line: (n) => `line ${n}`,
  list: (parts) => parts.join(' and '),
  fields: (fields) => `Check: ${fields}`,
  because: (reason, fields) => `${reason} Check: ${fields}`,
  reason: (e) => (e instanceof ApiError && e.code === 'SAME_ROUTE' ? 'Pick two places.' : null),
  detail: (detail) => `Not saved: ${detail}`,
  generic: () => 'Check the fields',
};

describe('invalidInputText', () => {
  it('names the fields of a refused request, with their line', () => {
    const e = new ApiError(400, '', ['items.0.weightKg', 'items.0.weightKg', 'services']);
    expect(invalidInputText(e, words)).toBe('Check: Weight (kg) (line 1) and Services');
  });

  it('keeps a field it has no label for, and a path-less issue as the API wrote it', () => {
    const e = new ApiError(400, '', ['lines.2.unitCost', 'Unrecognized key: "mode"']);
    expect(invalidInputText(e, words)).toBe(
      'Check: unitCost (line 3) and Unrecognized key: "mode"',
    );
  });

  it("gives a rule's reason when the API names no field, else the generic text", () => {
    expect(invalidInputText(new ApiError(400, 'Origin and destination must differ'), words)).toBe(
      'Not saved: Origin and destination must differ',
    );
    expect(invalidInputText(new ApiError(400, 'Bad Request'), words)).toBe('Check the fields');
    expect(invalidInputText(new Error('offline'), words)).toBe('Check the fields');
  });
});

describe('invalidInputText with a draft that misses values', () => {
  it('names each missing value, with its line', () => {
    const e = new ApiError(
      422,
      'x',
      ['services', 'items[0].weightKg'],
      'The draft is missing values',
      'DRAFT_INCOMPLETE',
    );
    expect(invalidInputText(e, words)).toBe('Check: Services and Weight (kg) (line 1)');
  });
});

describe('invalidInputText with a broken rule', () => {
  it('gives the reason for its code before the fields', () => {
    const e = new ApiError(
      400,
      'x',
      ['originLocationId'],
      'Origin and destination must differ',
      'SAME_ROUTE',
    );
    expect(invalidInputText(e, words)).toBe('Pick two places. Check: originLocationId');
  });
});

describe('invalidFields', () => {
  it('reads the paths of a 400 only', () => {
    expect([...invalidFields(new ApiError(400, '', ['services']))]).toEqual(['services']);
    expect(invalidFields(new ApiError(409, '', ['services'])).size).toBe(0);
    expect(invalidFields(new Error('x')).size).toBe(0);
  });
});

describe('asciiDigits', () => {
  it('reads Arabic-Indic and Persian digits and the Arabic decimal point', () => {
    expect(asciiDigits('١٢٣٫٥')).toBe('123.5');
    expect(asciiDigits('۱۲٬۳۰۰')).toBe('12300');
    expect(asciiDigits('12.5 kg')).toBe('12.5 kg');
    expect(asciiDigits('١٬٢٣٤٬٥٦٧٫٥')).toBe('1234567.5');
  });

  it('keeps a thousands separator that groups no thousands, so the API refuses the field', () => {
    expect(asciiDigits('١٢٬٥')).toBe('12\u066c5');
    expect(asciiDigits('٢٬٥٠')).toBe('2\u066c50');
    expect(asciiDigits('1٬5')).toBe('1\u066c5');
    expect(asciiDigits('١٢٣٤٬٥٦٧')).toBe('1234\u066c567');
  });
});

describe('api() refusals', () => {
  it('keeps the fields a broken rule names, with its reason', async () => {
    const { api } = await import('@/lib/api');
    const original = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            message: 'Give length, width and height together',
            code: 'DIMENSIONS_TOGETHER',
            fields: ['items.1.lengthCm'],
            statusCode: 400,
          }),
          { status: 400 },
        ),
      );
    try {
      const error = await api('/bookings', { method: 'POST', body: {} }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).message).toBe('Give length, width and height together');
      expect((error as ApiError).fields).toEqual(['items.1.lengthCm']);
      expect((error as ApiError).reason).toBe('Give length, width and height together');
      expect((error as ApiError).code).toBe('DIMENSIONS_TOGETHER');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('keeps the code and the values of a refusal that names no field', async () => {
    const { api } = await import('@/lib/api');
    const original = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            message: 'Only the branch of container NOL-CON-2026-000004 changes it',
            code: 'CONTAINER_BRANCH_ONLY',
            params: { container: 'NOL-CON-2026-000004', other: 3 },
            fields: [],
            statusCode: 403,
          }),
          { status: 403 },
        ),
      );
    try {
      const error = await api('/consolidations/x/shipments/y', { method: 'DELETE' }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).fields).toEqual([]);
      expect((error as ApiError).code).toBe('CONTAINER_BRANCH_ONLY');
      // Only text values are kept.
      expect((error as ApiError).params).toEqual({ container: 'NOL-CON-2026-000004' });
    } finally {
      globalThis.fetch = original;
    }
  });
});
