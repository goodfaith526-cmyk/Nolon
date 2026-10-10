import { parentPort } from 'node:worker_threads';
import { sheetPreview } from './sheet-preview.js';

// Runs one spreadsheet preview off the API's main thread (isolated-sheet-preview.ts), then exits.
parentPort?.once('message', (data: Uint8Array) => {
  void sheetPreview(Buffer.from(data.buffer, data.byteOffset, data.byteLength)).then(
    (preview) => parentPort?.postMessage(preview),
    () => parentPort?.postMessage(null),
  );
});
