import { HttpStatus, StreamableFile, UnprocessableEntityException } from '@nestjs/common';
import {
  IMPORT_MAX_BYTES,
  LOCALES,
  type ImportPreviewDto,
  type ImportRowsInvalidBody,
  type Locale,
  isLocale,
} from '@nolon/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';

/** What the import endpoints share: upload limits, request shapes and the template download. */

/**
 * Multer limits for an import upload, kept in memory. One byte over the cap is let through so the
 * service refuses an oversized file with its own error rather than a truncated read.
 */
export const IMPORT_UPLOAD_LIMITS = {
  limits: { fileSize: IMPORT_MAX_BYTES + 1, files: 1, fields: 2, parts: 3 },
};

export const templateQuery = z.object({ locale: z.enum(LOCALES).optional() }).strict();

export const commitBody = z.object({ requestId: z.uuid() }).strict();

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The language of a template: the one asked for, else the user's own. */
export function templateLocale(user: AuthUser, asked: Locale | undefined): Locale {
  if (asked) return asked;
  return isLocale(user.preferredLocale) ? user.preferredLocale : 'ar';
}

/** A template as a private, never cached .xlsx download. */
export function templateDownload(
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

/** 422: some rows are invalid, so nothing was written. The body carries the full preview. */
export function rowsInvalid(preview: ImportPreviewDto): UnprocessableEntityException {
  const body: ImportRowsInvalidBody = {
    statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    code: 'ROWS_INVALID',
    message: `${preview.totalRows - preview.validRows} of ${preview.totalRows} rows are invalid; nothing was imported`,
    preview,
  };
  return new UnprocessableEntityException(body);
}
