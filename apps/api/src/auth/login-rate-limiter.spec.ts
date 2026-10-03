import { describe, expect, it } from 'vitest';
import { EMAIL_RULE, FailureLimiter, IP_RULE } from './login-rate-limiter.js';

function limiter(rule = EMAIL_RULE) {
  let now = 0;
  const l = new FailureLimiter(rule, () => now);
  return { l, advance: (ms: number) => (now += ms) };
}

describe('FailureLimiter', () => {
  it('blocks after the 10th failure for an email, then lets it try again later', () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 9; i += 1) l.recordFailure('email:a');
    expect(l.isBlocked('email:a')).toBe(false);
    l.recordFailure('email:a');
    expect(l.isBlocked('email:a')).toBe(true);
    expect(l.isBlocked('email:b')).toBe(false);
    advance(EMAIL_RULE.blockMs);
    expect(l.isBlocked('email:a')).toBe(false);
  });

  it('forgets failures outside the window', () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 9; i += 1) l.recordFailure('email:a');
    advance(EMAIL_RULE.windowMs);
    l.recordFailure('email:a');
    expect(l.isBlocked('email:a')).toBe(false);
  });

  it('reset clears the count', () => {
    const { l } = limiter();
    for (let i = 0; i < 9; i += 1) l.recordFailure('email:a');
    l.reset('email:a');
    l.recordFailure('email:a');
    expect(l.isBlocked('email:a')).toBe(false);
  });

  it('allows more failures per IP than per email', () => {
    expect(IP_RULE.maxFailures).toBeGreaterThan(EMAIL_RULE.maxFailures);
  });
});
