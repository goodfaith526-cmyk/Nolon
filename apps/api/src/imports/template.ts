import { IMPORT_MAX_ROWS, type Locale } from '@nolon/shared';
import ExcelJS from 'exceljs';
import { type ImportColumn, type Labeled, headerText } from './import-sheet.js';

/**
 * Builds a downloadable import template: the data sheet (header row only), an instructions sheet
 * and a lists sheet whose values come from the database (branches, currencies, ports...). List
 * columns of the data sheet get a dropdown over the lists sheet.
 */

export interface TemplateList {
  key: string;
  title: Labeled;
  items: { code: string; name: string }[];
}

export interface TemplateSpec<K extends string> {
  locale: Locale;
  sheetName: Labeled;
  columns: readonly ImportColumn<K>[];
  lists: TemplateList[];
  /** Lines at the top of the instructions sheet. */
  notes: Labeled[];
}

const TEXT = {
  instructions: { en: 'Instructions', ar: 'التعليمات' },
  lists: { en: 'Lists', ar: 'القوائم' },
  column: { en: 'Column', ar: 'العمود' },
  required: { en: 'Required', ar: 'إلزامي' },
  yes: { en: 'Yes', ar: 'نعم' },
  no: { en: 'No', ar: 'لا' },
  format: { en: 'Format / allowed values', ar: 'الصيغة / القيم المسموحة' },
  code: { en: 'Code', ar: 'الرمز' },
  name: { en: 'Name', ar: 'الاسم' },
  general: [
    {
      en: 'Fill the first sheet only, one record per row, from row 2. Keep the header row (row 1) as it is.',
      ar: 'املأ الورقة الأولى فقط، سجلاً واحداً في كل صف بدءاً من الصف 2، واترك صف العناوين (الصف 1) كما هو.',
    },
    {
      en: 'Columns marked * are required. Values only: formulas are refused.',
      ar: 'الأعمدة المعلّمة بـ * إلزامية. قيم فقط: الصيغ (المعادلات) مرفوضة.',
    },
    {
      en: `Amounts: digits with an optional decimal point (at most 4 decimals), no thousands separators. Dates: YYYY-MM-DD. At most ${IMPORT_MAX_ROWS} rows per file.`,
      ar: `المبالغ: أرقام مع فاصلة عشرية اختيارية (4 خانات عشرية كحد أقصى) دون فواصل آلاف. التواريخ: YYYY-MM-DD. ${IMPORT_MAX_ROWS} صف كحد أقصى في الملف.`,
    },
    {
      en: 'Upload the file to see a preview. Nothing is saved until every row is valid and you confirm; then all rows are saved together.',
      ar: 'ارفع الملف لمعاينته. لا يُحفظ شيء حتى تصبح كل الصفوف صحيحة وتؤكد الاستيراد، وعندها تُحفظ كل الصفوف معاً.',
    },
  ] satisfies Labeled[],
} as const;

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE8EEF5' },
};

function quoteSheet(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function columnLetter(index: number): string {
  let n = index;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export async function buildTemplate<K extends string>(spec: TemplateSpec<K>): Promise<Buffer> {
  const { locale } = spec;
  const rtl = locale === 'ar';
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NOLON';

  const data = workbook.addWorksheet(spec.sheetName[locale].slice(0, 31), {
    views: [{ rightToLeft: rtl, state: 'frozen', ySplit: 1 }],
  });
  const instructions = workbook.addWorksheet(TEXT.instructions[locale], {
    views: [{ rightToLeft: rtl }],
  });
  const lists = workbook.addWorksheet(TEXT.lists[locale], {
    views: [{ rightToLeft: rtl, state: 'frozen', ySplit: 1 }],
  });

  // Lists: two columns (code, name) per list; dropdowns point at the code column.
  const listRanges = new Map<string, string>();
  spec.lists.forEach((list, i) => {
    const codeCol = i * 2 + 1;
    lists.getColumn(codeCol).width = 14;
    lists.getColumn(codeCol + 1).width = 30;
    const head = lists.getRow(1);
    head.getCell(codeCol).value = `${list.title[locale]} · ${TEXT.code[locale]}`;
    head.getCell(codeCol + 1).value = TEXT.name[locale];
    list.items.forEach((item, r) => {
      const row = lists.getRow(r + 2);
      row.getCell(codeCol).value = item.code;
      row.getCell(codeCol + 1).value = item.name;
    });
    if (list.items.length > 0) {
      const letter = columnLetter(codeCol);
      listRanges.set(
        list.key,
        `${quoteSheet(lists.name)}!$${letter}$2:$${letter}$${list.items.length + 1}`,
      );
    }
  });
  lists.getRow(1).font = { bold: true };

  // Data sheet: the header row, a text format on text and amount columns (so Excel keeps phone
  // numbers and amounts exactly as typed), a date format on dates, and dropdowns.
  const header = data.getRow(1);
  spec.columns.forEach((column, i) => {
    const col = data.getColumn(i + 1);
    col.width = column.width ?? (column.kind === 'text' ? 24 : 16);
    if (column.kind === 'date') col.numFmt = 'yyyy-mm-dd';
    else if (column.kind !== 'integer') col.numFmt = '@';
    const cell = header.getCell(i + 1);
    cell.value = headerText(column, locale);
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.border = { bottom: { style: 'thin' } };
    const range = column.list ? listRanges.get(column.list) : undefined;
    if (range) {
      for (let r = 2; r <= IMPORT_MAX_ROWS + 1; r++) {
        data.getCell(r, i + 1).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [range],
          showErrorMessage: true,
        };
      }
    }
  });

  // Instructions.
  instructions.getColumn(1).width = 30;
  instructions.getColumn(2).width = 10;
  instructions.getColumn(3).width = 80;
  instructions.addRow([spec.sheetName[locale]]).font = { bold: true, size: 14 };
  for (const line of [...spec.notes, ...TEXT.general]) instructions.addRow([line[locale]]);
  instructions.addRow([]);
  const head = instructions.addRow([
    TEXT.column[locale],
    TEXT.required[locale],
    TEXT.format[locale],
  ]);
  head.font = { bold: true };
  head.eachCell((cell) => {
    cell.fill = HEADER_FILL;
  });
  for (const column of spec.columns) {
    const row = instructions.addRow([
      headerText(column, locale),
      column.required ? TEXT.yes[locale] : TEXT.no[locale],
      column.hint[locale],
    ]);
    row.alignment = { wrapText: true, vertical: 'top' };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
