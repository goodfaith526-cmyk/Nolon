import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { HealthService } from './health.service.js';

function serviceWith(queryRaw: () => Promise<unknown>): HealthService {
  const prisma = { $queryRaw: vi.fn(queryRaw) } as unknown as PrismaService;
  return new HealthService(prisma);
}

describe('HealthService', () => {
  it('reports ok when the database answers', async () => {
    const result = await serviceWith(() => Promise.resolve([{ '?column?': 1 }])).check();
    expect(result.status).toBe('ok');
    expect(result.database).toBe('up');
  });

  it('reports error when the database is unreachable', async () => {
    const result = await serviceWith(() => Promise.reject(new Error('ECONNREFUSED'))).check();
    expect(result.status).toBe('error');
    expect(result.database).toBe('down');
  });
});
