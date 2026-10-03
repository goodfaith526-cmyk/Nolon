import { describe, expect, it } from 'vitest';
import { hashPassword, timingDummyHash, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[^$]+\$[^$]+$/);
    expect(hash).not.toContain('correct horse');
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true);
    await expect(verifyPassword('correct horse batterY', hash)).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('never verifies against a malformed hash', async () => {
    await expect(verifyPassword('x', '')).resolves.toBe(false);
    await expect(verifyPassword('x', 'plain-text')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$1$2$3$AAAA$AAAA')).resolves.toBe(false);
  });

  it('has a dummy hash that no guessed password matches', async () => {
    await expect(verifyPassword('', await timingDummyHash())).resolves.toBe(false);
  });
});
