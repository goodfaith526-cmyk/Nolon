import { describe, expect, it } from 'vitest';
import { createFormReviewBody, formReviewPermissions } from './form-review-rules.js';

const body = {
  form: 'booking',
  mode: 'create',
  values: { items: [{ weightKg: '12٬5' }] },
  invalidFields: ['items.0.weightKg'],
  reason: 'items.0.weightKg',
};

describe('a form kept for the assistant', () => {
  it('reads a refused booking', () => {
    const parsed = createFormReviewBody.parse({ ...body, customerName: ' Acme ' });
    expect(parsed.customerName).toBe('Acme');
    expect(createFormReviewBody.parse(body).customerName).toBeNull();
  });

  it('refuses other forms, unknown keys, odd paths and large bodies', () => {
    expect(createFormReviewBody.safeParse({ ...body, form: 'invoice' }).success).toBe(false);
    expect(createFormReviewBody.safeParse({ ...body, mode: 'delete' }).success).toBe(false);
    expect(createFormReviewBody.safeParse({ ...body, userId: 'x' }).success).toBe(false);
    expect(
      createFormReviewBody.safeParse({ ...body, invalidFields: ['items[0]; drop'] }).success,
    ).toBe(false);
    expect(
      createFormReviewBody.safeParse({ ...body, values: { text: 'x'.repeat(17_000) } }).success,
    ).toBe(false);
  });

  it('needs the permission saving the form needs', () => {
    expect(formReviewPermissions('booking', 'create')).toEqual(['bookings:create']);
    expect(formReviewPermissions('booking', 'edit')).toEqual(['bookings:update']);
    expect(formReviewPermissions('booking', 'container')).toEqual([
      'container_booking:create',
      'bookings:create',
      'bookings:approve',
    ]);
    expect(formReviewPermissions('quotation', 'create')).toEqual(['quotations:create']);
    expect(formReviewPermissions('quotation', 'edit')).toEqual(['quotations:update']);
    // No quotation is made from a container.
    expect(formReviewPermissions('quotation', 'container')).toEqual([]);
  });
});
