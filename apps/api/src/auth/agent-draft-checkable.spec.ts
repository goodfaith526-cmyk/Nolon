import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the pre-checks the staff AI assistant may call: POST /<kind>-drafts/check runs the checks
// of that kind's create with nothing written. Each one sits next to a create the assistant may
// call (@AgentDraftWritable), asks for exactly the create's permissions and calls only the
// service's checkValues.

const SRC = join(import.meta.dirname, '..');

function controllers(): { file: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.controller.ts'))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(SRC, file), 'utf8') }));
}

/** The decorators and handler after each marker, up to the end of the handler. */
function marked(text: string, marker: string): string[] {
  const found: string[] = [];
  let at = text.indexOf(marker);
  while (at !== -1) {
    const end = text.indexOf('\n  }\n', at);
    found.push(text.slice(at, end === -1 ? undefined : end));
    at = text.indexOf(marker, at + marker.length);
  }
  return found;
}

const permissionOf = (handler: string): string | undefined =>
  /@RequirePermission\(([^)]*)\)/.exec(handler)?.[1];

describe('pre-checks the staff assistant may call', () => {
  it('are opened only through the decorator', () => {
    const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .filter((f) =>
        /AGENT_DRAFT_CHECKABLE|auth:agentDraftCheckable/.test(readFileSync(join(SRC, f), 'utf8')),
      )
      .sort();
    expect(files).toEqual([join('auth', 'auth.guard.ts'), join('auth', 'decorators.ts')]);
  });

  it('sit next to every draft create the assistant may call, except the GRN draft', () => {
    const withCheck = controllers()
      .filter((c) => c.text.includes('@AgentDraftCheckable()'))
      .map((c) => c.file);
    const withCreate = controllers()
      .filter((c) => c.text.includes('@AgentDraftWritable()'))
      .map((c) => c.file)
      // A GRN draft comes from a document the assistant read, not from values a person typed;
      // the settle route answers for a create already made, with no values to check.
      .filter((f) => f !== join('warehouse', 'grn-drafts.controller.ts'))
      .filter((f) => f !== join('my-drafts', 'my-drafts.controller.ts'));
    expect(withCheck).toEqual(withCreate);
  });

  it("are each a POST 'check' with the create's permissions, calling only checkValues", () => {
    for (const { file, text } of controllers()) {
      const checks = marked(text, '@AgentDraftCheckable()');
      if (checks.length === 0) continue;
      expect(checks, file).toHaveLength(1);
      const check = checks[0]!;
      const [create] = marked(text, '@AgentDraftWritable()');
      expect(check, file).toMatch(
        /^@AgentDraftCheckable\(\)\n\s*@Post\('check'\)\n\s*@HttpCode\(HttpStatus\.OK\)\n\s*@RequirePermission\([^)]*\)\n\s*check\(/,
      );
      expect(permissionOf(check), file).toBe(permissionOf(create ?? ''));
      expect(check, file).toContain('this.drafts.checkValues(user, input)');
      expect(check.match(/this\.drafts\.\w+/g), file).toEqual(['this.drafts.checkValues']);
    }
  });
});
