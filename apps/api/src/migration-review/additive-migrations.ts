// Classifies the migrations a pull request adds (AGENTS.md rule 4). A migration passes only when
// every statement is in a small allowed subset of additive SQL that touches no accounting object;
// anything else, including anything this file cannot parse, needs the owner's OK. The OK is a
// label naming the digest of the exact migrations reviewed, so any later change to them needs a
// new OK. Runs in CI straight from this file (Node strips the types): Node built-ins only.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

// ---------------------------------------------------------------------------------------------
// Tokens. Unquoted words are folded to lower case, as PostgreSQL does; quoted identifiers keep
// their case. Comments are dropped; string and $$ bodies are single tokens.

type Token =
  | { kind: 'word'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'body'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'punct'; value: string };

class Unparsable extends Error {}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const closing = (tag: string, from: number) => {
    const end = sql.indexOf(tag, from);
    if (end < 0) throw new Unparsable('unterminated quote');
    return end;
  };
  while (i < sql.length) {
    const c = sql[i] ?? '';
    const rest = sql.slice(i, i + 2);
    if (/\s/.test(c)) {
      i++;
    } else if (rest === '--') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
    } else if (rest === '/*') {
      i = closing('*/', i + 2) + 2;
    } else if (c === "'" || c === '"') {
      // E'..', U&'..', B'..' and the like read backslashes differently: never in a migration here.
      if (/[A-Za-z0-9_&]/.test(sql[i - 1] ?? '')) throw new Unparsable('prefixed string');
      let value = '';
      let at = i + 1;
      for (;;) {
        const end = closing(c, at);
        value += sql.slice(at, end);
        // A doubled quote is an escaped quote.
        if (sql[end + 1] === c) {
          value += c;
          at = end + 2;
          continue;
        }
        i = end + 1;
        break;
      }
      tokens.push(c === "'" ? { kind: 'string', value } : { kind: 'ident', value });
    } else if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (!tag) throw new Unparsable('unexpected $');
      const end = closing(tag, i + tag.length);
      tokens.push({ kind: 'body', value: sql.slice(i + tag.length, end) });
      i = end + tag.length;
    } else if (/[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))?.[0] ?? c;
      tokens.push({ kind: 'word', value: word.toLowerCase() });
      i += word.length;
    } else if (/[0-9]/.test(c)) {
      const number = /^[0-9]+(\.[0-9]+)?/.exec(sql.slice(i))?.[0] ?? c;
      tokens.push({ kind: 'number', value: number });
      i += number.length;
    } else {
      const punct = rest === '::' ? '::' : c;
      tokens.push({ kind: 'punct', value: punct });
      i += punct.length;
    }
  }
  return tokens;
}

/** Statements as token lists, split on semicolons (never inside strings or $$ bodies). */
function splitStatements(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.kind === 'punct' && token.value === ';') {
      if (current.length > 0) out.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function show(tokens: Token[]): string {
  return tokens
    .map((t) =>
      t.kind === 'ident'
        ? `"${t.value}"`
        : t.kind === 'string'
          ? `'${t.value}'`
          : t.kind === 'body'
            ? '$$…$$'
            : t.value,
    )
    .join(' ')
    .slice(0, 160);
}

/** Every name a statement mentions, folded to lower case, including inside function bodies. */
function names(tokens: Token[]): string[] {
  return tokens.flatMap((t) =>
    t.kind === 'word' || t.kind === 'ident'
      ? [t.value.toLowerCase()]
      : t.kind === 'body'
        ? names(tokenize(t.value))
        : [],
  );
}

// ---------------------------------------------------------------------------------------------
// A cursor over one statement. Each `expect…` throws Unparsable when the next tokens differ, so
// a statement outside the allowed shapes fails closed.

class Cursor {
  private at = 0;
  private readonly tokens: Token[];
  // No parameter properties: CI runs this file with Node's type stripping.
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  get done(): boolean {
    return this.at >= this.tokens.length;
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.at + offset];
  }

  isWord(...words: string[]): boolean {
    return words.every((w, n) => {
      const t = this.peek(n);
      return t?.kind === 'word' && t.value === w;
    });
  }

  isPunct(value: string): boolean {
    const t = this.peek();
    return t?.kind === 'punct' && t.value === value;
  }

  /** Consumes the words if they come next. */
  optWords(...words: string[]): boolean {
    if (!this.isWord(...words)) return false;
    this.at += words.length;
    return true;
  }

  words(...words: string[]): void {
    if (!this.optWords(...words)) throw new Unparsable(`expected ${words.join(' ')}`);
  }

  punct(value: string): void {
    if (!this.isPunct(value)) throw new Unparsable(`expected ${value}`);
    this.at++;
  }

  next(): Token {
    const t = this.peek();
    if (!t) throw new Unparsable('unexpected end');
    this.at++;
    return t;
  }

  /** A table, type, column or constraint name; only the public schema may be named. */
  name(): string {
    const first = this.next();
    if (first.kind !== 'word' && first.kind !== 'ident') throw new Unparsable('expected a name');
    if (!this.isPunct('.')) return first.value;
    this.at++;
    if (first.value !== 'public') throw new Unparsable('another schema');
    const second = this.next();
    if (second.kind !== 'word' && second.kind !== 'ident') throw new Unparsable('expected a name');
    return second.value;
  }

  /** Tokens up to the parenthesis that closes the one just opened (consumed). */
  balanced(): Token[] {
    this.punct('(');
    const inner: Token[] = [];
    let depth = 1;
    for (;;) {
      const t = this.next();
      if (t.kind === 'punct' && t.value === '(') depth++;
      if (t.kind === 'punct' && t.value === ')' && --depth === 0) return inner;
      inner.push(t);
    }
  }

  /** A parenthesised list of names. */
  nameList(): string[] {
    this.punct('(');
    const list = [this.name()];
    while (this.isPunct(',')) {
      this.at++;
      list.push(this.name());
    }
    this.punct(')');
    return list;
  }

  end(): void {
    if (!this.done) throw new Unparsable(`unexpected ${show([this.next()])}`);
  }
}

/** Splits a token list on commas outside parentheses (the actions of one ALTER TABLE). */
function topLevel(tokens: Token[]): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === 'punct' && t.value === '(') depth++;
    if (t.kind === 'punct' && t.value === ')') depth--;
    if (t.kind === 'punct' && t.value === ',' && depth === 0) parts.push([]);
    else parts[parts.length - 1]?.push(t);
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// The allowed subset.

interface State {
  /** Tables created by an earlier migration (on the base branch). */
  existingTables: ReadonlySet<string>;
  /** Tables this pull request creates: empty until it fills them. */
  newTables: Set<string>;
  /** Functions this pull request creates. */
  newFunctions: Set<string>;
  /** `table.column` added by this pull request as nullable without a default: NULL in old rows. */
  nullColumns: Set<string>;
}

/** A column type: a name, optional (n[, m]), optional [], optional WITH/WITHOUT TIME ZONE. */
function columnType(c: Cursor): void {
  c.name();
  if (c.isPunct('(')) {
    c.punct('(');
    if (c.next().kind !== 'number') throw new Unparsable('type size');
    if (c.isPunct(',')) {
      c.punct(',');
      if (c.next().kind !== 'number') throw new Unparsable('type size');
    }
    c.punct(')');
  }
  if (c.isPunct('[')) {
    c.punct('[');
    c.punct(']');
  }
  if (!c.optWords('with', 'time', 'zone')) c.optWords('without', 'time', 'zone');
}

/** A constant default: a number, a string (optionally cast), a boolean or the current time. */
function literal(c: Cursor): void {
  if (c.isPunct('-')) c.punct('-');
  const t = c.next();
  if (t.kind === 'number') return;
  if (t.kind === 'string') {
    if (c.isPunct('::')) {
      c.punct('::');
      columnType(c);
    }
    return;
  }
  if (t.kind === 'word' && ['true', 'false', 'null', 'current_timestamp'].includes(t.value)) return;
  throw new Unparsable('default is not a constant');
}

function alterExistingTable(table: string, action: Token[], state: State): string | null {
  const c = new Cursor(action);
  try {
    if (c.optWords('add', 'constraint')) {
      c.name();
      c.words('foreign', 'key');
      const columns = c.nameList();
      c.words('references');
      c.name();
      c.nameList();
      while (c.optWords('on')) {
        if (!c.optWords('delete') && !c.optWords('update')) throw new Unparsable('on');
        if (!c.optWords('restrict') && !c.optWords('cascade') && !c.optWords('no', 'action')) {
          c.words('set');
          if (!c.optWords('null')) c.words('default');
        }
      }
      c.end();
      // A foreign key on columns this pull request added as NULL holds no old value to check.
      return columns.every((col) => state.nullColumns.has(`${table}.${col}`))
        ? null
        : `foreign key on existing data of ${table}`;
    }
    c.words('add');
    c.optWords('column');
    const column = c.name();
    columnType(c);
    if (c.done) {
      state.nullColumns.add(`${table}.${column}`);
      return null;
    }
    if (c.optWords('null')) {
      c.end();
      state.nullColumns.add(`${table}.${column}`);
      return null;
    }
    // A constant default, NOT NULL or not: old rows take the default and nothing else is checked.
    if (c.optWords('not', 'null')) {
      c.words('default');
      literal(c);
    } else {
      c.words('default');
      literal(c);
      c.optWords('not', 'null');
    }
    c.end();
    return null;
  } catch (error) {
    if (error instanceof Unparsable) return `changes existing table ${table}: ${show(action)}`;
    throw error;
  }
}

/** Words that may be followed by "(" in a trigger function's body; any other call is refused. */
const BODY_CALLS = new Set([
  'if',
  'elsif',
  'and',
  'or',
  'not',
  'in',
  'exists',
  'case',
  'when',
  'then',
  'else',
  'return',
  'coalesce',
  'nullif',
  'greatest',
  'least',
  'is',
  'values',
]);

/** Words that would let a trigger function do more than check rows and raise. */
const BODY_FORBIDDEN = new Set([
  'insert',
  'update',
  'delete',
  'truncate',
  'merge',
  'execute',
  'perform',
  'copy',
  'alter',
  'drop',
  'create',
  'grant',
  'revoke',
  'call',
  'lock',
  'notify',
  'listen',
  'set',
  'reset',
  'commit',
  'rollback',
  'security',
  'do',
]);

/**
 * A trigger function's body: it may read tables this pull request creates and raise; it may not
 * write, run dynamic SQL, or call any function outside a few pure built-ins.
 */
function functionBody(body: string, state: State): void {
  const tokens = tokenize(body);
  tokens.forEach((t, n) => {
    const next = tokens[n + 1];
    if (t.kind === 'word' && BODY_FORBIDDEN.has(t.value)) throw new Unparsable(t.value);
    if (next?.kind === 'punct' && next.value === '(') {
      if (t.kind === 'ident' || (t.kind === 'word' && !BODY_CALLS.has(t.value))) {
        throw new Unparsable(`calls ${t.value}`);
      }
    }
    if (t.kind === 'word' && (t.value === 'from' || t.value === 'join')) {
      const source = tokens[n + 1];
      if (
        (source?.kind !== 'word' && source?.kind !== 'ident') ||
        !state.newTables.has(source.value)
      ) {
        throw new Unparsable('reads an existing table');
      }
    }
  });
}

/** Null when the statement is in the allowed subset; otherwise why not. */
function review(statement: Token[], state: State): string | null {
  const accounting = [...new Set(names(statement))].filter((n) => ACCOUNTING_OBJECTS.has(n));
  if (accounting.length > 0) return `touches accounting: ${accounting.join(', ')}`;

  const c = new Cursor(statement);
  try {
    if (c.optWords('create', 'type')) {
      c.name();
      c.words('as', 'enum');
      c.balanced();
      c.end();
      return null;
    }
    if (c.optWords('create', 'table')) {
      const table = c.name();
      c.balanced();
      c.end();
      if (state.existingTables.has(table)) return `table ${table} already exists`;
      state.newTables.add(table);
      return null;
    }
    if (c.isWord('create', 'index') || c.isWord('create', 'unique', 'index')) {
      c.words('create');
      const unique = c.optWords('unique');
      c.words('index');
      c.name();
      c.words('on');
      const table = c.name();
      if (c.optWords('using')) c.name();
      if (state.newTables.has(table)) {
        c.balanced();
        c.end();
        return null;
      }
      // On an existing table: a plain index on plain columns (it cannot fail on old rows).
      c.nameList();
      c.end();
      return unique ? `unique index on existing table ${table}` : null;
    }
    if (c.optWords('alter', 'type')) {
      c.name();
      c.words('add', 'value');
      c.optWords('if', 'not', 'exists');
      if (c.next().kind !== 'string') throw new Unparsable('enum value');
      if (c.optWords('before') || c.optWords('after')) {
        if (c.next().kind !== 'string') throw new Unparsable('enum value');
      }
      c.end();
      return null;
    }
    if (c.optWords('alter', 'table')) {
      c.optWords('only');
      const table = c.name();
      const actions = topLevel(statement.slice(statement.length - remaining(c)));
      if (state.newTables.has(table)) {
        // A table this pull request creates holds no rows: any added column or constraint.
        for (const action of actions) {
          if (!new Cursor(action).isWord('add')) return `changes table ${table}: ${show(action)}`;
        }
        return null;
      }
      for (const action of actions) {
        const reason = alterExistingTable(table, action, state);
        if (reason) return reason;
      }
      return null;
    }
    if (c.optWords('create', 'function')) {
      const fn = c.name();
      c.punct('(');
      c.punct(')');
      c.words('returns', 'trigger');
      let body: string | null = null;
      while (!c.done) {
        if (c.optWords('as')) {
          const t = c.next();
          if (t.kind !== 'body') throw new Unparsable('function body');
          body = t.value;
        } else {
          c.words('language', 'plpgsql');
        }
      }
      if (body === null) throw new Unparsable('function body');
      functionBody(body, state);
      state.newFunctions.add(fn);
      return null;
    }
    if (c.optWords('create', 'trigger')) {
      c.name();
      if (!c.optWords('before') && !c.optWords('after')) throw new Unparsable('trigger timing');
      do {
        if (!['insert', 'update', 'delete', 'truncate'].some((e) => c.optWords(e))) {
          throw new Unparsable('trigger event');
        }
      } while (c.optWords('or'));
      c.words('on');
      const table = c.name();
      c.words('for', 'each');
      if (!c.optWords('row')) c.words('statement');
      c.words('execute');
      if (!c.optWords('function')) c.words('procedure');
      const fn = c.name();
      c.punct('(');
      c.punct(')');
      c.end();
      if (!state.newTables.has(table)) return `trigger on existing table ${table}`;
      if (!state.newFunctions.has(fn)) return `trigger runs a function this change does not create`;
      return null;
    }
    if (c.optWords('insert', 'into')) {
      const table = c.name();
      c.nameList();
      c.words('values');
      do {
        c.punct('(');
        do {
          if (c.isWord('gen_random_uuid') || c.isWord('now')) {
            c.next();
            c.punct('(');
            c.punct(')');
          } else {
            literal(c);
          }
        } while (c.isPunct(',') && (c.punct(','), true));
        c.punct(')');
      } while (c.isPunct(',') && (c.punct(','), true));
      if (c.optWords('on', 'conflict')) {
        if (c.isPunct('(')) c.nameList();
        c.words('do', 'nothing');
      }
      c.end();
      return state.newTables.has(table) ? null : `inserts rows into existing table ${table}`;
    }
  } catch (error) {
    if (!(error instanceof Unparsable)) throw error;
  }
  return 'not in the allowed additive subset';
}

/** How many tokens the cursor has not consumed. */
function remaining(c: Cursor): number {
  let n = 0;
  while (c.peek(n)) n++;
  return n;
}

/** Table names created by migrations already applied (the base branch). */
export function createdTables(sqls: string[]): Set<string> {
  const tables = new Set<string>();
  for (const sql of sqls) {
    let statements: Token[][];
    try {
      statements = splitStatements(tokenize(sql));
    } catch {
      continue;
    }
    for (const statement of statements) {
      const c = new Cursor(statement);
      try {
        if (c.optWords('create', 'table')) {
          c.optWords('if', 'not', 'exists');
          tables.add(c.name());
        }
      } catch {
        // Not a table name this file can read: it is not counted as new either way.
      }
    }
  }
  return tables;
}

/**
 * Why the added migrations are not additive; empty when every statement is in the allowed subset.
 * `files` are in the order they apply; `existingTables` were created before them.
 */
export function reviewMigrations(
  files: { file: string; sql: string }[],
  existingTables: ReadonlySet<string> = new Set(),
): Finding[] {
  const state: State = {
    existingTables,
    newTables: new Set(),
    newFunctions: new Set(),
    nullColumns: new Set(),
  };
  const findings: Finding[] = [];
  for (const { file, sql } of files) {
    let statements: Token[][];
    try {
      statements = splitStatements(tokenize(sql));
    } catch {
      findings.push({ file, statement: '', reason: 'cannot be parsed' });
      continue;
    }
    for (const statement of statements) {
      const reason = review(statement, state);
      if (reason) findings.push({ file, statement: show(statement), reason });
    }
  }
  return findings;
}

/** The digest an owner's sign-off names: every added migration's path and exact bytes. */
export function migrationsDigest(files: { file: string; sql: string }[]): string {
  const hash = createHash('sha256');
  for (const { file, sql } of [...files].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    hash.update(`${file}\0${sql.length}\0${sql}\0`);
  }
  return hash.digest('hex').slice(0, 16);
}

/** The label that signs off exactly these migrations. */
export function signOffLabel(files: { file: string; sql: string }[]): string {
  return `migration-ok-${migrationsDigest(files)}`;
}

const MIGRATIONS = 'apps/api/prisma/migrations';

/** CI: reviews the migrations added since `base`; exits 1 when they need the owner's OK. */
function main(base: string, labels: string[]): void {
  const added = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`, '--', MIGRATIONS],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((f) => f.endsWith('/migration.sql'))
    .sort();
  const files = added.map((file) => ({ file, sql: readFileSync(file, 'utf8') }));
  const earlier = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(MIGRATIONS, d.name, 'migration.sql'))
    .filter((file) => !added.includes(file))
    .map((file) => readFileSync(file, 'utf8'));
  const findings = reviewMigrations(files, createdTables(earlier));
  const label = signOffLabel(files);
  const lines =
    added.length === 0
      ? ['No new migrations.']
      : findings.length === 0
        ? [`Additive only: ${added.join(', ')}. Merges on review and green CI.`]
        : [
            `These migrations are not additive. After a tested backup and the owner's explicit OK, sign off exactly this content with the label \`${label}\`:`,
            ...findings.map((f) => `- ${f.file}: ${f.reason}\n  \`${f.statement}\``),
          ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
  if (findings.length > 0 && !labels.includes(label)) {
    console.log(`::error::Migration is not additive and is not signed off (label ${label}).`);
    process.exitCode = 1;
  } else if (findings.length > 0) {
    console.log(`Signed off by the owner (label ${label}).`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const labels = JSON.parse(process.env.PR_LABELS ?? '[]') as unknown;
  main(
    process.argv[2] ?? 'origin/main',
    Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string') : [],
  );
}
