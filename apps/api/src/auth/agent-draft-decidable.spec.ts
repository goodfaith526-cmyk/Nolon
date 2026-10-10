import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the decisions the staff AI assistant may relay: a person's approve or reject of an
// entry draft they asked the assistant for, pressed on a card in the chat. Every route marked
// @AgentDraftDecidable() is listed here with the permission it requires; adding one is a new
// decision path for the assistant and goes through review with this list. Goods receipts (GRN)
// are never decided from the chat: their approval needs receipt details a person enters.

const SRC = join(import.meta.dirname, '..');

function route(action: 'approve' | 'reject', permission: string, handler: string): RegExp {
  return new RegExp(
    `^\\s*@Post\\(':id/assistant-${action}'\\)\\n\\s*@HttpCode\\(HttpStatus\\.OK\\)\\n` +
      `\\s*@RequirePermission\\('${permission}'\\)\\n\\s*${handler}\\(`,
  );
}

/** Controller file, then the decorators and handler that follow the marker, exactly. */
const ALLOWED: readonly { file: string; handler: RegExp }[] = [
  {
    file: join('billing', 'invoice-drafts.controller.ts'),
    handler: route('approve', 'customer_invoices:create', 'approveFromAssistant'),
  },
  {
    file: join('billing', 'invoice-drafts.controller.ts'),
    handler: route('reject', 'customer_invoices:create', 'rejectFromAssistant'),
  },
  {
    file: join('billing', 'receipt-drafts.controller.ts'),
    handler: route('approve', 'receipts:create', 'approveFromAssistant'),
  },
  {
    file: join('billing', 'receipt-drafts.controller.ts'),
    handler: route('reject', 'receipts:create', 'rejectFromAssistant'),
  },
  {
    file: join('bookings', 'booking-drafts.controller.ts'),
    handler: route('approve', 'bookings:create', 'approveFromAssistant'),
  },
  {
    file: join('bookings', 'booking-drafts.controller.ts'),
    handler: route('reject', 'bookings:create', 'rejectFromAssistant'),
  },
  {
    file: join('quotations', 'quotation-drafts.controller.ts'),
    handler: route('approve', 'quotations:create', 'approveFromAssistant'),
  },
  {
    file: join('quotations', 'quotation-drafts.controller.ts'),
    handler: route('reject', 'quotations:create', 'rejectFromAssistant'),
  },
  {
    file: join('transport', 'trip-drafts.controller.ts'),
    handler: route('approve', 'transport_trips:create', 'approveFromAssistant'),
  },
  {
    file: join('transport', 'trip-drafts.controller.ts'),
    handler: route('reject', 'transport_trips:create', 'rejectFromAssistant'),
  },
  {
    file: join('warehouse', 'goods-release-drafts.controller.ts'),
    handler: route('approve', 'warehouse:create', 'approveFromAssistant'),
  },
  {
    file: join('warehouse', 'goods-release-drafts.controller.ts'),
    handler: route('reject', 'warehouse:create', 'rejectFromAssistant'),
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
      if (line.trim().startsWith('@AgentDraftDecidable(')) {
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
      /AGENT_DRAFT_DECIDABLE|auth:agentDraftDecidable/.test(readFileSync(join(SRC, f), 'utf8')),
    )
    .sort();
}

describe('draft decisions the staff assistant may relay', () => {
  it('are opened only through the decorator', () => {
    expect(filesUsingTheKey()).toEqual([
      join('auth', 'auth.guard.ts'),
      join('auth', 'decorators.ts'),
    ]);
  });

  it('are exactly the listed assistant approve and reject routes', () => {
    const marked = markedRoutes();
    expect(marked.map((m) => m.file)).toEqual(ALLOWED.map((a) => a.file));
    marked.forEach((m, i) => {
      expect(m.handler).toMatch(ALLOWED[i]!.handler);
    });
  });

  it('never include goods receipts', () => {
    expect(markedRoutes().filter((m) => m.file.includes('grn'))).toEqual([]);
  });
});
