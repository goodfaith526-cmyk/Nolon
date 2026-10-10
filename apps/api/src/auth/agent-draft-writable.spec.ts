import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the one write the staff AI assistant may make: creating a GRN draft that only a person
// can approve. Any other route marked @AgentDraftWritable() is a new write path for the
// assistant and must not appear by accident.

const SRC = join(import.meta.dirname, '..');

function markedRoutes(): { file: string; handler: string }[] {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) =>
    f.endsWith('.controller.ts'),
  );
  const found: { file: string; handler: string }[] = [];
  for (const file of files) {
    const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.trim() === '@AgentDraftWritable()') {
        found.push({ file, handler: lines.slice(i + 1, i + 6).join('\n') });
      }
    });
  }
  return found;
}

describe('routes the staff assistant may write to', () => {
  it('are exactly the GRN draft creation', () => {
    const marked = markedRoutes();
    expect(marked).toHaveLength(1);
    const [only] = marked;
    expect(only?.file).toBe(join('warehouse', 'grn-drafts.controller.ts'));
    expect(only?.handler).toMatch(
      /^\s*@Post\(\)\n\s*@RequirePermission\('warehouse:create', 'documents:view'\)\n\s*create\(/,
    );
  });
});
