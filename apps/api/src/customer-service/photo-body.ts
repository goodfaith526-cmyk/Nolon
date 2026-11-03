import { CS_REQUEST_PHOTO_MAX_BYTES } from '@nolon/shared';
import type { NextFunction, Request, Response } from 'express';

const PHOTO_PATH = /^\/api\/v1\/cs\/booking-requests\/[0-9a-f-]{36}\/photos$/;
/** The most of a refused body read and discarded, and for how long, before the socket closes. */
const DISCARD_MAX_BYTES = 64 * 1024 * 1024;
const DISCARD_MAX_MS = 30_000;

/**
 * Plan 09 section 12: a photo comes as the raw request body (one image, no multipart), so the
 * signed channel identity covers its exact bytes. Read here for that path only, up to 10 MB (413
 * beyond, once the rest is discarded), into `rawBody` and `body`; every other path keeps the JSON
 * parser and its limit. The image type is checked from the bytes by the service.
 */
export function photoBody(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST' || !PHOTO_PATH.test(req.path)) {
    next();
    return;
  }
  // Codex F171-3: an oversize body is read to its end and discarded, and only then answered 413
  // (with the connection closing), so a client still sending gets the answer, never a reset
  // socket. Discarding is bounded: a declared length past DISCARD_MAX_BYTES is answered at once,
  // and past DISCARD_MAX_BYTES read or DISCARD_MAX_MS the socket is closed anyway.
  const chunks: Buffer[] = [];
  let stopped = false;
  const answer = () => {
    if (res.headersSent) return;
    res.setHeader('Connection', 'close');
    res.status(413).json({
      statusCode: 413,
      code: 'PHOTO_TOO_LARGE',
      message: 'A photo is at most 10 MB',
    });
  };
  const tooLarge = (read: number) => {
    stopped = true;
    chunks.length = 0;
    let discarded = read;
    const timer = setTimeout(() => req.destroy(), DISCARD_MAX_MS);
    timer.unref();
    req.on('data', (chunk: Buffer) => {
      discarded += chunk.length;
      if (discarded > DISCARD_MAX_BYTES) req.destroy();
    });
    req.on('end', () => {
      clearTimeout(timer);
      answer();
    });
    req.on('close', () => clearTimeout(timer));
    req.resume();
  };
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > DISCARD_MAX_BYTES) {
    answer();
    req.destroy();
    return;
  }
  if (declared > CS_REQUEST_PHOTO_MAX_BYTES) {
    tooLarge(0);
    return;
  }
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    if (stopped) return;
    size += chunk.length;
    if (size > CS_REQUEST_PHOTO_MAX_BYTES) {
      tooLarge(size);
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
