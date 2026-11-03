import { CS_REQUEST_PHOTO_MAX_BYTES } from '@nolon/shared';
import type { NextFunction, Request, Response } from 'express';

const PHOTO_PATH = /^\/api\/v1\/cs\/booking-requests\/[0-9a-f-]{36}\/photos$/;

/**
 * Plan 09 section 12: a photo comes as the raw request body (one image, no multipart), so the
 * signed channel identity covers its exact bytes. Read here for that path only, up to 10 MB (413
 * beyond, without reading the rest), into `rawBody` and `body`; every other path keeps the JSON
 * parser and its limit. The image type is checked from the bytes by the service.
 */
export function photoBody(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST' || !PHOTO_PATH.test(req.path)) {
    next();
    return;
  }
  const tooLarge = () =>
    res.status(413).json({
      statusCode: 413,
      code: 'PHOTO_TOO_LARGE',
      message: 'A photo is at most 10 MB',
    });
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > CS_REQUEST_PHOTO_MAX_BYTES) {
    tooLarge();
    req.destroy();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let stopped = false;
  req.on('data', (chunk: Buffer) => {
    if (stopped) return;
    size += chunk.length;
    if (size > CS_REQUEST_PHOTO_MAX_BYTES) {
      stopped = true;
      tooLarge();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (stopped) return;
    const bytes = Buffer.concat(chunks);
    const raw = req as Request & { rawBody?: Buffer; _body?: boolean };
    raw.rawBody = bytes;
    raw.body = bytes;
    // Tells the JSON and form parsers the body is read already.
    raw._body = true;
    next();
  });
  req.on('error', (error) => {
    if (!stopped) next(error);
  });
}
