import { describe, expect, it } from 'vitest';
import { assistantPageUrl, pageRecord } from './assistant-page';

const ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const ASSISTANT = 'https://agent.example/?tenant=nolon';

describe('the assistant button on a record page', () => {
  it("opens the assistant on a shipment's or a customer's record", () => {
    expect(pageRecord(`/shipments/${ID}`)).toEqual({ kind: 'shipment', id: ID });
    expect(pageRecord(`/ar/customers/${ID.toUpperCase()}`)).toEqual({ kind: 'customer', id: ID });
    expect(assistantPageUrl(ASSISTANT, `/en/shipments/${ID}`)).toBe(
      `https://agent.example/?tenant=nolon#record=shipment:${ID}`,
    );
  });

  it('opens it as it is on any other page', () => {
    for (const path of [
      '/',
      '/shipments',
      '/shipments/new',
      `/shipments/${ID}/print`,
      `/invoices/${ID}`,
      `/constructor/${ID}`,
      '/customers/not-an-id',
    ]) {
      expect(pageRecord(path)).toBeNull();
      expect(assistantPageUrl(ASSISTANT, path)).toBe(ASSISTANT);
    }
  });
});
