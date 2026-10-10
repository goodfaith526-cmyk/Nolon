import { fileURLToPath } from 'node:url';
import { type ResourceLimits, Worker } from 'node:worker_threads';
import type { SheetPreviewDto } from '@nolon/shared';

/** Wall time a preview may take, worker start included; past it the worker is killed. */
const TIME_LIMIT_MS = 3000;
/** Heap the worker may use: the file's parts (at most 32 MiB inflated) and the XML as text. */
const RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 160,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
};

/**
 * When the API runs from its TypeScript sources (the tests), the worker is a .ts file too. Node
 * strips its types; this hook lets its `./x.js` imports find `./x.ts`.
 */
const SOURCE_IMPORTS_HOOK = `data:text/javascript,${encodeURIComponent(
  `import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve(s, c, next) {' +
  '  try { return await next(s, c); } catch (e) {' +
  '    if (s.startsWith(".") && s.endsWith(".js")) return next(s.slice(0, -3) + ".ts", c);' +
  '    throw e; } }'));`,
)}`;

export interface IsolationOptions {
  timeLimitMs?: number;
  resourceLimits?: ResourceLimits;
}

/**
 * sheetPreview (sheet-preview.ts) in a worker thread of its own, with a heap limit and a wall
 * time limit: a file that would exhaust memory or time kills only its worker, never the API.
 * Null when the file is unreadable, the worker runs out of memory, fails, or takes too long.
 */
export function isolatedSheetPreview(
  data: Buffer,
  options: IsolationOptions = {},
): Promise<SheetPreviewDto | null> {
  const fromSource = fileURLToPath(import.meta.url).endsWith('.ts');
  const worker = new Worker(
    new URL(
      fromSource ? './sheet-preview.worker.ts' : './sheet-preview.worker.js',
      import.meta.url,
    ),
    {
      resourceLimits: options.resourceLimits ?? RESOURCE_LIMITS,
      execArgv: fromSource ? ['--import', SOURCE_IMPORTS_HOOK] : [],
      env: {},
      stdout: true,
      stderr: true,
    },
  );
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SheetPreviewDto | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), options.timeLimitMs ?? TIME_LIMIT_MS);
    worker.once('message', (result: SheetPreviewDto | null) => finish(result));
    worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));
    const copy = new Uint8Array(data);
    worker.postMessage(copy, [copy.buffer]);
  });
}
