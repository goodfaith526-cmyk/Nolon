import { StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { XLSX_CONTENT_TYPE } from './excel.js';

/** An exported report as a private, never cached .xlsx download. */
export function xlsxDownload(
  res: Response,
  file: { fileName: string; data: Buffer },
): StreamableFile {
  res.set({
    'Content-Type': XLSX_CONTENT_TYPE,
    'Content-Disposition': `attachment; filename="${file.fileName}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  return new StreamableFile(file.data);
}
