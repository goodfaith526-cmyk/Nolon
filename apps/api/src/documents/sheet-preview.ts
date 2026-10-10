import { posix } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  SHEET_PREVIEW_MAX_COLUMNS,
  SHEET_PREVIEW_MAX_ROWS,
  type SheetPreviewDto,
} from '@nolon/shared';
import { SaxesParser } from 'saxes';
import { unpackZip } from '../common/zip-guard.js';

/** The same bound as when the workbook was accepted (file-type.ts). */
const ZIP_LIMITS = { maxEntries: 200, maxUncompressedBytes: 32 * 1024 * 1024 };
/** Wall time one preview may take, parsing included; past it the preview is refused. */
const TIME_BUDGET_MS = 2000;
/** XML is parsed in slices this long; the budget is checked and the event loop freed between. */
const SLICE_CHARS = 64 * 1024;
const MAX_CELL_CHARS = 500;
const MAX_SHEET_NAME_CHARS = 100;
/** Excel's own limits: a reference beyond them is not a real workbook. */
const MAX_ROW = 1_048_576;
const MAX_COLUMN = 16_384;

type CellValue = string | { shared: number };

interface Budget {
  deadline: number;
}

/**
 * The first sheet of a stored .xlsx as text cells, for a person to compare a draft with.
 *
 * Read with a streaming XML parser over the parts the zip guard inflated under its cap, so the
 * work is linear in those bytes and nothing is allocated per row or column index: a cell
 * referenced at row 1,000,000 costs what a cell at row 1 does. Reading stops after the rows the
 * preview shows. The parser expands no custom entities and fetches nothing; formulas are never
 * evaluated (their stored result is shown); numbers, dates included, are shown as stored.
 *
 * Null when the file is unreadable, references a cell beyond Excel's limits, or takes longer
 * than the time budget.
 */
export async function sheetPreview(
  data: Buffer,
  options: { timeBudgetMs?: number } = {},
): Promise<SheetPreviewDto | null> {
  const budget = { deadline: Date.now() + (options.timeBudgetMs ?? TIME_BUDGET_MS) };
  const entries = unpackZip(data, ZIP_LIMITS);
  if (!entries) return null;
  const parts = new Map(
    entries.map((e) => [e.name.toString(e.utf8Name ? 'utf8' : 'latin1').toLowerCase(), e.content]),
  );
  const part = (name: string) => parts.get(name.toLowerCase());

  const workbook = part('xl/workbook.xml');
  const rels = part('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) return null;
  const first = await firstSheet(workbook, budget);
  const targets = first && (await relationships(rels, budget));
  if (!first || !targets) return null;
  const sheetPath = targets.byId.get(first.relId);
  const sheetXml = sheetPath && part(sheetPath);
  if (!sheetXml) return null;

  const sheet = await readSheet(sheetXml, budget);
  if (!sheet) return null;
  const needed = new Set<number>();
  for (const row of sheet.rows) {
    for (const value of row.cells.values()) if (typeof value !== 'string') needed.add(value.shared);
  }
  let strings = new Map<number, string>();
  if (needed.size > 0) {
    const stringsXml = part(targets.sharedStrings ?? 'xl/sharedStrings.xml');
    const read = stringsXml && (await sharedStrings(stringsXml, needed, budget));
    if (!read) return null;
    strings = read;
  }

  return {
    sheetName: first.name.slice(0, MAX_SHEET_NAME_CHARS),
    truncated: sheet.truncated,
    rows: sheet.rows.map((row) => {
      const width = Math.max(...row.cells.keys());
      const cells: string[] = [];
      for (let col = 1; col <= width; col++) {
        const value = row.cells.get(col);
        cells.push(
          value === undefined
            ? ''
            : typeof value === 'string'
              ? value
              : (strings.get(value.shared) ?? ''),
        );
      }
      return { rowNumber: row.rowNumber, cells };
    }),
  };
}

interface XmlHandlers {
  /** Return true to stop reading. */
  open?(name: string, attributes: Record<string, string>): boolean | void;
  close?(name: string): boolean | void;
  text?(text: string): void;
}

/** Streams one XML part through the handlers; false when it is malformed or over budget. */
async function readXml(xml: Buffer, handlers: XmlHandlers, budget: Budget): Promise<boolean> {
  const parser = new SaxesParser();
  let stopped = false;
  parser.on('opentag', (tag) => {
    if (!stopped && handlers.open?.(localName(tag.name), tag.attributes)) stopped = true;
  });
  parser.on('closetag', (tag) => {
    if (!stopped && handlers.close?.(localName(tag.name))) stopped = true;
  });
  const onText = (text: string) => {
    if (!stopped) handlers.text?.(text);
  };
  parser.on('text', onText);
  parser.on('cdata', onText);
  const text = xml.toString('utf8');
  try {
    for (let i = 0; i < text.length && !stopped; i += SLICE_CHARS) {
      parser.write(text.slice(i, i + SLICE_CHARS));
      if (Date.now() > budget.deadline) return false;
      await nextTurn();
    }
    if (!stopped) parser.close();
  } catch {
    return false;
  }
  return Date.now() <= budget.deadline;
}

/** Element names without a namespace prefix (some writers use x:row). */
function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

async function firstSheet(
  xml: Buffer,
  budget: Budget,
): Promise<{ name: string; relId: string } | null> {
  let found: { name: string; relId: string } | null = null;
  const ok = await readXml(
    xml,
    {
      open(name, attributes) {
        if (name !== 'sheet') return false;
        const relId = Object.entries(attributes).find(
          ([key]) => localName(key) === 'id' && key.includes(':'),
        )?.[1];
        found = relId ? { name: attributes.name ?? '', relId } : null;
        return true;
      },
    },
    budget,
  );
  return ok ? found : null;
}

async function relationships(
  xml: Buffer,
  budget: Budget,
): Promise<{ byId: Map<string, string>; sharedStrings: string | null } | null> {
  const byId = new Map<string, string>();
  let sharedStrings: string | null = null;
  const ok = await readXml(
    xml,
    {
      open(name, attributes) {
        if (name !== 'Relationship' || !attributes.Id || !attributes.Target) return;
        if (attributes.TargetMode === 'External') return;
        const target = attributes.Target.startsWith('/')
          ? posix.normalize(attributes.Target.slice(1))
          : posix.normalize(`xl/${attributes.Target}`);
        byId.set(attributes.Id, target);
        if (attributes.Type?.endsWith('/sharedStrings')) sharedStrings = target;
      },
    },
    budget,
  );
  return ok ? { byId, sharedStrings } : null;
}

/** "B12" → column 2 (null when not a reference within Excel's limits). */
function columnOf(reference: string): number | null {
  const match = /^([A-Z]{1,3})([0-9]{1,7})$/.exec(reference);
  if (!match?.[1]) return null;
  let column = 0;
  for (const letter of match[1]) column = column * 26 + (letter.charCodeAt(0) - 64);
  return column <= MAX_COLUMN && Number(match[2]) <= MAX_ROW ? column : null;
}

function rowOf(reference: string): number | null {
  if (!/^[0-9]{1,7}$/.test(reference)) return null;
  const row = Number(reference);
  return row >= 1 && row <= MAX_ROW ? row : null;
}

async function readSheet(
  xml: Buffer,
  budget: Budget,
): Promise<{
  rows: { rowNumber: number; cells: Map<number, CellValue> }[];
  truncated: boolean;
} | null> {
  const rows: { rowNumber: number; cells: Map<number, CellValue> }[] = [];
  let truncated = false;
  let invalid = false;
  let inSheetData = false;
  let rowNumber = 0;
  let cells: Map<number, CellValue> | null = null;
  let column = 0;
  let cell: { column: number; type: string; text: string } | null = null;
  let inValue = false;
  let inInline = false;
  let inText = false;
  let inPhonetic = false;

  const ok = await readXml(
    xml,
    {
      open(name, attributes) {
        if (name === 'sheetData') {
          inSheetData = true;
        } else if (!inSheetData) {
          return false;
        } else if (name === 'row') {
          const at = attributes.r === undefined ? rowNumber + 1 : rowOf(attributes.r);
          if (at === null || at > MAX_ROW) return (invalid = true);
          rowNumber = at;
          cells = new Map();
          column = 0;
        } else if (name === 'c' && cells) {
          const at = attributes.r === undefined ? column + 1 : columnOf(attributes.r);
          if (at === null || at > MAX_COLUMN) return (invalid = true);
          column = at;
          cell = { column: at, type: attributes.t ?? 'n', text: '' };
        } else if (cell && name === 'v') {
          inValue = true;
        } else if (cell && name === 'is') {
          inInline = true;
        } else if (inInline && name === 'rPh') {
          inPhonetic = true;
        } else if (inInline && name === 't') {
          inText = true;
        }
        return false;
      },
      text(text) {
        if (!cell || !(inValue || (inText && !inPhonetic))) return;
        if (cell.text.length < MAX_CELL_CHARS) {
          cell.text = (cell.text + text).slice(0, MAX_CELL_CHARS);
        }
      },
      close(name) {
        if (name === 'v') inValue = false;
        else if (name === 't') inText = false;
        else if (name === 'rPh') inPhonetic = false;
        else if (name === 'is') inInline = false;
        else if (name === 'c' && cell && cells) {
          const value = cellValue(cell.type, cell.text);
          if (value !== null) {
            if (cell.column > SHEET_PREVIEW_MAX_COLUMNS) truncated = true;
            else cells.set(cell.column, value);
          }
          cell = null;
        } else if (name === 'row' && cells) {
          if (cells.size > 0) {
            if (rows.length >= SHEET_PREVIEW_MAX_ROWS) return (truncated = true);
            rows.push({ rowNumber, cells });
          }
          cells = null;
        } else if (name === 'sheetData') {
          return true;
        }
        return false;
      },
    },
    budget,
  );
  return ok && !invalid ? { rows, truncated } : null;
}

/** A cell's text as shown; a shared string by its index; null for an empty cell. */
function cellValue(type: string, text: string): CellValue | null {
  if (text === '') return null;
  if (type === 's') {
    const index = /^[0-9]{1,9}$/.test(text) ? Number(text) : NaN;
    return Number.isSafeInteger(index) ? { shared: index } : null;
  }
  if (type === 'b') return text === '1' ? 'true' : 'false';
  return text;
}

/** The shared strings the preview uses, each capped; reading stops after the last one needed. */
async function sharedStrings(
  xml: Buffer,
  needed: ReadonlySet<number>,
  budget: Budget,
): Promise<Map<number, string> | null> {
  const last = Math.max(...needed);
  const strings = new Map<number, string>();
  let index = -1;
  let current: string | null = null;
  let inText = false;
  let inPhonetic = false;
  const ok = await readXml(
    xml,
    {
      open(name) {
        if (name === 'si') {
          index++;
          current = needed.has(index) ? '' : null;
        } else if (name === 'rPh') inPhonetic = true;
        else if (name === 't') inText = true;
        return false;
      },
      text(text) {
        if (current !== null && inText && !inPhonetic && current.length < MAX_CELL_CHARS) {
          current = (current + text).slice(0, MAX_CELL_CHARS);
        }
      },
      close(name) {
        if (name === 't') inText = false;
        else if (name === 'rPh') inPhonetic = false;
        else if (name === 'si') {
          if (current !== null) strings.set(index, current);
          current = null;
          return index >= last;
        }
        return false;
      },
    },
    budget,
  );
  return ok ? strings : null;
}
