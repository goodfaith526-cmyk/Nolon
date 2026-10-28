import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Plan 03, F114-1 / F114-4: the write inventory (docs/plans/03a-permissions-write-inventory.md) is a
// gate. It is rebuilt here from the TypeScript AST of every controller and matched against the
// document both ways: a write route missing from the document fails, a row naming no route fails,
// and two routes on one verb + path fail. A new write route is added to the document on purpose.

const SRC = join(import.meta.dirname, '..');
const DOC = join(SRC, '../../../docs/plans/03a-permissions-write-inventory.md');

interface Row {
  file: string;
  controller: string;
  verb: string;
  path: string;
  handler: string;
  permissions: string;
}

const text = (e: ts.Expression | undefined): string | null =>
  e && ts.isStringLiteralLike(e) ? e.text : null;

function controllerPath(decorators: readonly ts.Decorator[]): string | null {
  for (const d of decorators) {
    const call = d.expression;
    if (!ts.isCallExpression(call) || call.expression.getText() !== 'Controller') continue;
    const arg = call.arguments[0];
    if (!arg) return '';
    if (ts.isObjectLiteralExpression(arg)) {
      const prop = arg.properties.find((p) => p.name?.getText() === 'path');
      return prop && ts.isPropertyAssignment(prop) ? text(prop.initializer) : null;
    }
    return text(arg);
  }
  return null;
}

/** Every POST, PATCH, PUT and DELETE route of `source` (one file may hold several controllers). */
function writeRoutes(file: string, source: string): Row[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const rows: Row[] = [];
  sf.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || !node.name) return;
    const base = controllerPath(ts.getDecorators(node) ?? []);
    if (base === null) return;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      let verb: string | null = null;
      let sub = '';
      let permissions: string[] = [];
      for (const d of ts.getDecorators(member) ?? []) {
        if (!ts.isCallExpression(d.expression)) continue;
        const name = d.expression.expression.getText();
        if (['Post', 'Patch', 'Put', 'Delete'].includes(name)) {
          verb = name.toUpperCase();
          sub = text(d.expression.arguments[0]) ?? '';
        }
        if (name === 'RequirePermission') {
          permissions = d.expression.arguments.map((a) => text(a) ?? a.getText());
        }
      }
      if (!verb) continue;
      const path = `/${[base, sub].filter(Boolean).join('/')}`
        .replace(/\/+/g, '/')
        .replace(/(.)\/$/, '$1');
      rows.push({
        file,
        controller: node.name.text,
        verb,
        path,
        handler: member.name.getText(),
        permissions: permissions.join(', ') || '—',
      });
    }
  });
  return rows;
}

/** A repository path as the document writes it, with `/` on every platform. */
function posix(path: string, separator: string = sep): string {
  return path.split(separator).join('/');
}

function codeRows(): Row[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.controller.ts'))
    .sort()
    .flatMap((f) =>
      // The document writes paths with `/`; Windows gives `\` (Codex F118-2).
      writeRoutes(posix(relative(SRC, join(SRC, f))), readFileSync(join(SRC, f), 'utf8')),
    );
}

function docRows(): Row[] {
  const cell = (c: string) => c.trim().replace(/^`|`$/g, '');
  return readFileSync(DOC, 'utf8')
    .split('\n')
    .filter((line) => /^\|\s*\d+\s*\|/.test(line))
    .map((line) => {
      const [, file, controller, verb, path, handler, permissions] = line
        .split('|')
        .slice(1, -1)
        .map(cell);
      return {
        file: file ?? '',
        controller: controller ?? '',
        verb: verb ?? '',
        path: path ?? '',
        handler: handler ?? '',
        permissions: permissions ?? '',
      };
    });
}

const key = (r: Row) => `${r.verb} ${r.path} ${r.controller}.${r.handler}`;

describe('the write inventory gate', () => {
  it('reads several controllers in one file and upload routes', () => {
    const rows = writeRoutes(
      'x.controller.ts',
      `@Controller('a') class A {
         @Post(':id/photos') @UseInterceptors(FileInterceptor('file'))
         @RequirePermission('pod:create', 'documents:create') addPhoto() {}
       }
       @Controller({ path: 'b' }) class B { @Delete() remove() {} @Get() list() {} }`,
    );
    expect(rows.map(key)).toEqual(['POST /a/:id/photos A.addPhoto', 'DELETE /b B.remove']);
    expect(rows[0]?.permissions).toBe('pod:create, documents:create');
    expect(rows[1]?.permissions).toBe('—');
  });

  it('writes file paths with / whatever the platform (Windows gives \\)', () => {
    expect(posix('accounting\\accounting.controller.ts', '\\')).toBe(
      'accounting/accounting.controller.ts',
    );
    expect(posix('accounting/accounting.controller.ts', '/')).toBe(
      'accounting/accounting.controller.ts',
    );
  });

  it('matches the code both ways, with its permissions, and no route twice', () => {
    const code = codeRows();
    const doc = docRows();
    const routes = code.map((r) => `${r.verb} ${r.path}`);
    expect(routes.filter((r, i) => routes.indexOf(r) !== i)).toEqual([]);
    const docKeys = new Map(doc.map((r) => [key(r), r]));
    const codeKeys = new Map(code.map((r) => [key(r), r]));
    expect(doc.length, 'a key twice in the document').toBe(docKeys.size);
    expect(
      [...codeKeys.keys()].filter((k) => !docKeys.has(k)),
      'missing from 03a',
    ).toEqual([]);
    expect(
      [...docKeys.keys()].filter((k) => !codeKeys.has(k)),
      'no longer in the code',
    ).toEqual([]);
    for (const [k, r] of codeKeys) {
      expect(docKeys.get(k)?.permissions, k).toBe(r.permissions);
      expect(docKeys.get(k)?.file, k).toBe(r.file);
    }
  });
});
