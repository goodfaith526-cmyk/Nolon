import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the writes the staff AI assistant may make: creating an entry draft that only a person
// can approve. Every route marked @AgentDraftWritable() is listed here, with the permissions it
// requires; adding one is a new write path for the assistant and goes through review with this
// list.

const SRC = join(import.meta.dirname, '..');

/** Controller file, then the decorators and handler that follow the marker, exactly. */
const ALLOWED: readonly { file: string; handler: RegExp }[] = [
  {
    file: join('billing', 'invoice-drafts.controller.ts'),
    handler: /^\s*@Post\(\)\n\s*@RequirePermission\('customer_invoices:create'\)\n\s*create\(/,
  },
  {
    file: join('billing', 'receipt-drafts.controller.ts'),
    handler: /^\s*@Post\(\)\n\s*@RequirePermission\('receipts:create'\)\n\s*create\(/,
  },
  {
    file: join('bookings', 'booking-drafts.controller.ts'),
    handler: /^\s*@Post\(\)\n\s*@RequirePermission\('bookings:create'\)\n\s*create\(/,
  },
  {
    file: join('bookings', 'new-customer-booking-drafts.controller.ts'),
    handler:
      /^\s*@Post\(\)\n\s*@RequirePermission\('bookings:create', 'customers:create'\)\n\s*create\(/,
  },
  {
    file: join('customers', 'customer-drafts.controller.ts'),
    handler: /^\s*@Post\(\)\n\s*@RequirePermission\('customers:create'\)\n\s*create\(/,
  },
  {
    file: join('customers', 'party-drafts.controller.ts'),
    handler: /^\s*@Post\(\)\n\s*@RequirePermission\('customers:update'\)\n\s*create\(/,
  },
  {
    // Settles the key of a create whose answer was lost: writes at most a "not created" record.
    file: join('my-drafts', 'my-drafts.controller.ts'),
    handler: /^\s*@Post\('settle'\)\n\s*@HttpCode\(HttpStatus\.OK\)\n\s*settle\(/,
  },
  {
    // Acknowledges a settled key: writes at most its ledger row's acknowledgement.
    file: join('my-drafts', 'my-drafts.controller.ts'),
    handler: /^\s*@Post\('settle\/ack'\)\n\s*@HttpCode\(HttpStatus\.OK\)\n\s*acknowledge\(/,
  },
  {
    file: join('quotations', 'quotation-drafts.controller.ts'),
    handler: /^\s*@Post\(\)\n\s*@RequirePermission\('quotations:create'\)\n\s*create\(/,
  },
  {
    file: join('rates', 'rate-card-drafts.controller.ts'),
    handler: /^\s*@Post\(\)\n\s*@RequirePermission\('rates:create'\)\n\s*create\(/,
  },
  {
    file: join('shipments', 'shipment-status-drafts.controller.ts'),
    handler: /^\s*@Post\(\)\n\s*@RequirePermission\('shipments:view'\)\n\s*create\(/,
  },
  {
    file: join('transport', 'trip-drafts.controller.ts'),
    handler: /^\s*@Post\(\)\n\s*@RequirePermission\('transport_trips:create'\)\n\s*create\(/,
  },
  {
    file: join('warehouse', 'goods-release-drafts.controller.ts'),
    handler: /^\s*@Post\(\)\n\s*@RequirePermission\('warehouse:create'\)\n\s*create\(/,
  },
  {
    file: join('warehouse', 'grn-drafts.controller.ts'),
    handler:
      /^\s*@Post\(\)\n\s*@RequirePermission\('warehouse:create', 'documents:view'\)\n\s*create\(/,
  },
];

function markedRoutes(): { file: string; handler: string }[] {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .sort();
  const found: { file: string; handler: string }[] = [];
  for (const file of files) {
    const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.trim().startsWith('@AgentDraftWritable(')) {
        found.push({ file, handler: lines.slice(i + 1, i + 6).join('\n') });
      }
    });
  }
  return found;
}

/** Files that name the metadata key itself: only the decorator and the guard may. */
function filesUsingTheKey(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .filter((f) =>
      /AGENT_DRAFT_WRITABLE|auth:agentDraftWritable/.test(readFileSync(join(SRC, f), 'utf8')),
    )
    .sort();
}

describe('routes the staff assistant may write to', () => {
  it('are opened only through the decorator', () => {
    expect(filesUsingTheKey()).toEqual([
      join('auth', 'auth.guard.ts'),
      join('auth', 'decorators.ts'),
    ]);
  });

  it('are exactly the listed draft creations', () => {
    const marked = markedRoutes();
    expect(marked.map((m) => m.file)).toEqual(ALLOWED.map((a) => a.file));
    marked.forEach((m, i) => {
      expect(m.handler).toMatch(ALLOWED[i]!.handler);
    });
  });

  it('are each a POST that creates (or settles a create), never an edit, decision or delete', () => {
    for (const m of markedRoutes()) {
      expect(m.handler).toMatch(
        /^\s*@Post\(\)\n(\s*@RequirePermission\([^)]*\)\n)?\s*create\(|^\s*@Post\('settle(\/ack)?'\)\n\s*@HttpCode\(HttpStatus\.OK\)\n\s*(settle|acknowledge)\(/,
      );
    }
  });
});
