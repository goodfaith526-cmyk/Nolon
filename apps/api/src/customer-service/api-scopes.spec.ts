import { Reflector } from '@nestjs/core';
import { CS_SCOPES } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { API_SCOPE_KEY, keyScopes, scopeRows } from './api-scopes.js';
import {
  CatalogController,
  CustomerServiceController,
  CustomerTokensController,
} from './customer-service.controller.js';

describe('Customer Service API scopes', () => {
  it.each([CustomerServiceController, CustomerTokensController, CatalogController])(
    'names a scope on every route of the API-key controller %o',
    (controller) => {
      const reflector = new Reflector();
      const proto = controller.prototype as unknown as Record<string, unknown>;
      const routes = Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor');
      expect(routes.length).toBeGreaterThan(0);
      for (const name of routes) {
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        const scope = reflector.getAllAndOverride<string | undefined>(API_SCOPE_KEY, [
          handler,
          controller,
        ]);
        expect(CS_SCOPES, name).toContain(scope);
      }
    },
  );

  it('keeps the original reads on the column and the rest as rows', () => {
    expect(scopeRows(['cs:customers:read', 'cs:quote:read'])).toEqual(['QUOTE_READ']);
    expect(keyScopes(false, [{ scope: 'QUOTE_READ' }], CS_SCOPES)).toEqual(['cs:quote:read']);
    expect(keyScopes(true, [], CS_SCOPES)).toEqual(['cs:customers:read']);
    expect(keyScopes(false, [], CS_SCOPES)).toEqual([]);
    expect(
      keyScopes(
        false,
        scopeRows(CS_SCOPES).map((scope) => ({ scope })),
        CS_SCOPES,
      ),
    ).toEqual(CS_SCOPES.filter((s) => s !== 'cs:customers:read'));
  });
});
