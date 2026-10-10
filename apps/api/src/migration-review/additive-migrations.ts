// Classifies the migrations a pull request adds (AGENTS.md rule 4). An additive migration only
// adds objects and touches no accounting table: it merges on review and green CI. Anything else
// needs the owner's explicit OK, recorded as the `migration-signed-off` label. Runs in CI straight
// from this file (Node strips the types), so it uses Node built-ins only.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Tables and types of the accounting ledger and the documents that post to it. */
export const ACCOUNTING_OBJECTS: ReadonlySet<string> = new Set([
  'account_type',
  'accounts',
  'posting_role',
  'account_mappings',
  'charge_type_postings',
  'period_status',
  'fiscal_periods',
  'fx_rates',
  'journal_status',
  'journal_source',
  'journal_entries',
  'journal_lines',
  'invoice_status',
  'customer_invoices',
  'customer_invoice_lines',
  'receipt_status',
  'receipts',
  'receipt_allocations',
  'credit_note_status',
  'credit_notes',
  'supplier_bill_status',
  'supplier_bills',
  'supplier_bill_line_kind',
  'supplier_bill_lines',
  'supplier_payment_status',
  'supplier_payments',
  'supplier_payment_allocations',
  'expense_categories',
  'expense_status',
  'expenses',
  'trip_expense_status',
  'trip_expenses',
]);

export interface Finding {
  file: string;
  statement: string;
  reason: string;
}

/** The SQL's statements without comments, split on semicolons outside quotes and $$ bodies. */
export function statements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      current += ' ';
      continue;
    }
    const dollar = /^\$[A-Za-z0-9_]*\$/.exec(rest);
    const quote = rest[0] === "'" || rest[0] === '"' ? rest[0] : null;
    if (dollar || quote) {
      const tag = dollar ? dollar[0] : (quote ?? '');
      let end = sql.indexOf(tag, i + tag.length);
      // A doubled quote inside a quoted string or identifier is an escaped quote.
      while (quote && end >= 0 && sql[end + 1] === quote) end = sql.indexOf(tag, end + 2);
      const stop = end < 0 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (rest[0] === ';') {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else {
      current += rest[0];
    }
    i++;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** "public"."Name" or name → name (identifiers compared as Prisma writes them). */
function identifier(raw: string): string {
  const parts = raw.split('.');
  return (parts[parts.length - 1] ?? '').replace(/^"|"$/g, '');
}

const NAME = String.raw`((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))?)`;
const re = (source: string) => new RegExp(source, 'is');

/** Splits on commas outside parentheses and quotes (the actions of one ALTER TABLE). */
function topLevelParts(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
    } else if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Accounting tables or types a statement names, quoted or not (comments are already gone). */
function accountingNames(statement: string): string[] {
  const words = statement.match(/"[^"]+"|[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return [...new Set(words.map((w) => w.replace(/^"|"$/g, '')))].filter((w) =>
    ACCOUNTING_OBJECTS.has(w),
  );
}

/**
 * Why each statement of the added migrations is not additive; empty when all of them are.
 * `files` are in the order they apply. Objects created by any of them count as new.
 */
export function reviewMigrations(files: { file: string; sql: string }[]): Finding[] {
  const newTables = new Set<string>();
  const newColumns = new Set<string>();
  const findings: Finding[] = [];

  for (const { file, sql } of files) {
    for (const statement of statements(sql)) {
      const flag = (reason: string) => findings.push({ file, statement, reason });
      const accounting = accountingNames(statement);
      if (accounting.length > 0) {
        flag(`touches accounting: ${accounting.join(', ')}`);
        continue;
      }
      let m: RegExpExecArray | null;
      if (
        (m = re(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}\\s*\\(`).exec(statement))
      ) {
        newTables.add(identifier(m[1] ?? ''));
      } else if (re(`^CREATE\\s+TYPE\\s+${NAME}\\s+AS\\s+ENUM\\b`).test(statement)) {
        // A new enum type.
      } else if (re(`^ALTER\\s+TYPE\\s+${NAME}\\s+ADD\\s+VALUE\\b`).test(statement)) {
        // A new enum value.
      } else if (
        (m = re(
          `^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}\\s+ON\\s+(?:ONLY\\s+)?${NAME}`,
        ).exec(statement))
      ) {
        const table = identifier(m[3] ?? '');
        // Existing rows may already break a new unique index: the deploy would fail.
        if (m[1] && !newTables.has(table)) flag(`unique index on existing table ${table}`);
      } else if (
        (m = re(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?${NAME}\\s+(.*)$`).exec(
          statement,
        ))
      ) {
        const table = identifier(m[1] ?? '');
        for (const action of topLevelParts(m[2] ?? '')) {
          const reason = alterAction(table, action, newTables, newColumns);
          if (reason) flag(reason);
        }
      } else if (
        (m = re(`^CREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+${NAME}\\s.*?\\sON\\s+${NAME}`).exec(
          statement,
        ))
      ) {
        const table = identifier(m[2] ?? '');
        if (!newTables.has(table)) flag(`trigger on existing table ${table}`);
      } else if ((m = re(`^INSERT\\s+INTO\\s+${NAME}`).exec(statement))) {
        // Seed rows of a table this pull request creates; rows added to an existing table are not.
        const table = identifier(m[1] ?? '');
        if (!newTables.has(table)) flag(`inserts rows into existing table ${table}`);
      } else if (re(`^CREATE\\s+FUNCTION\\s`).test(statement)) {
        // A new function (without OR REPLACE it cannot change an existing one). Its body may
        // write only to tables this pull request creates, and may not run dynamic SQL.
        for (const reason of functionBody(statement, newTables)) flag(reason);
      } else {
        flag('not an additive statement');
      }
    }
  }
  return findings;
}

function functionBody(statement: string, newTables: ReadonlySet<string>): string[] {
  const reasons: string[] = [];
  if (/\bEXECUTE\s+(?!FUNCTION\b|PROCEDURE\b)/i.test(statement))
    reasons.push('function runs dynamic SQL');
  const writes = new RegExp(
    `\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?|DROP\\s+\\w+|ALTER\\s+\\w+)\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?${NAME}`,
    'gi',
  );
  for (const m of statement.matchAll(writes)) {
    const target = identifier(m[1] ?? '');
    if (!newTables.has(target)) reasons.push(`function changes existing object ${target}`);
  }
  return reasons;
}

function alterAction(
  table: string,
  action: string,
  newTables: ReadonlySet<string>,
  newColumns: Set<string>,
): string | null {
  const isNew = newTables.has(table);
  let m: RegExpExecArray | null;
  if (
    (m = re(`^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}\\s+(.*)$`).exec(action)) &&
    !/^ADD\s+CONSTRAINT\b/i.test(action)
  ) {
    const column = identifier(m[1] ?? '');
    const definition = m[2] ?? '';
    newColumns.add(`${table}.${column}`);
    if (!isNew && /\bNOT\s+NULL\b/i.test(definition) && !/\bDEFAULT\b/i.test(definition)) {
      return `new NOT NULL column without a default on existing table ${table}`;
    }
    return null;
  }
  if ((m = re(`^ADD\\s+CONSTRAINT\\s+${NAME}\\s+(.*)$`).exec(action))) {
    if (isNew) return null;
    const fk = re(`^FOREIGN\\s+KEY\\s*\\(([^)]*)\\)`).exec(m[2] ?? '');
    const columns = (fk?.[1] ?? '').split(',').map((c) => identifier(c.trim()));
    // A foreign key on columns this pull request added holds no old rows to check.
    if (fk && columns.every((c) => newColumns.has(`${table}.${c}`))) return null;
    return `constraint on existing table ${table}`;
  }
  return `changes existing table ${table}: ${action.split(/\s+/).slice(0, 3).join(' ')}`;
}

const MIGRATIONS = 'apps/api/prisma/migrations';

/** CI: reviews the migrations added since `base`; exits 1 when one needs the owner's OK. */
function main(base: string, signedOff: boolean): void {
  const added = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`, '--', MIGRATIONS],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter((f) => f.endsWith('/migration.sql'))
    .sort();
  const findings = reviewMigrations(
    added.map((file) => ({ file, sql: readFileSync(file, 'utf8') })),
  );
  const lines =
    added.length === 0
      ? ['No new migrations.']
      : findings.length === 0
        ? [`Additive only: ${added.join(', ')}. Merges on review and green CI.`]
        : [
            "These migrations are not additive. They need a tested backup and the owner's explicit OK (label `migration-signed-off`):",
            ...findings.map(
              (f) =>
                `- ${f.file}: ${f.reason}\n  \`${f.statement.replace(/\s+/g, ' ').slice(0, 160)}\``,
            ),
          ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  if (findings.length > 0 && !signedOff) {
    console.log('::error::Migration is not additive and is not signed off by the owner.');
    process.exitCode = 1;
  } else if (findings.length > 0) {
    console.log('Signed off by the owner (label migration-signed-off).');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ?? 'origin/main', process.env.MIGRATION_SIGNED_OFF === 'true');
}
