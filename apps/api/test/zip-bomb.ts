import { constants, crc32, deflateRawSync } from 'node:zlib';

/**
 * A zip "bomb" for tests: one deflated entry of `megabytes` MiB of zeros, a few KiB on disk,
 * whose headers declare it holds only `declaredSize` bytes. Built from one compressed MiB repeated
 * (each copy is a self-contained, byte-aligned deflate segment), so it is cheap to make.
 */
export function lyingZipBomb(megabytes: number, declaredSize = 100): Buffer {
  const mib = deflateRawSync(Buffer.alloc(1 << 20), { finishFlush: constants.Z_FULL_FLUSH });
  // A final, empty block with fixed codes ends the deflate stream.
  const data = Buffer.concat([
    ...Array.from({ length: megabytes }, () => mib),
    Buffer.from([3, 0]),
  ]);
  const name = Buffer.from('xl/worksheets/sheet1.xml');
  const crc = crc32(Buffer.alloc(declaredSize));

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);

  const directoryOffset = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
