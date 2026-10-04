import type { LimitRule } from '../common/failure-limiter.js';

export { FailureLimiter, type LimitRule } from '../common/failure-limiter.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** Per email: 10 failures in 15 minutes blocks that email for 15 minutes. */
export const EMAIL_RULE: LimitRule = {
  maxFailures: 10,
  windowMs: FIFTEEN_MINUTES,
  blockMs: FIFTEEN_MINUTES,
};

/** Per client IP: 50 failures in 15 minutes blocks that IP for 15 minutes. */
export const IP_RULE: LimitRule = {
  maxFailures: 50,
  windowMs: FIFTEEN_MINUTES,
  blockMs: FIFTEEN_MINUTES,
};
