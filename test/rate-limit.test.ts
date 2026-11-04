import assert from 'node:assert/strict';
import test from 'node:test';
import { FixedWindowRateLimiter } from '../src/rate-limit.js';

test('fixed-window rate limits reset after the window', () => {
  const limiter = new FixedWindowRateLimiter(2, 1_000, 10);
  assert.equal(limiter.allow('client-a', 100), true);
  assert.equal(limiter.allow('client-a', 200), true);
  assert.equal(limiter.allow('client-a', 300), false);
  assert.equal(limiter.allow('client-a', 1_100), true);
});

test('fixed-window rate limiter bounds memory as caller addresses rotate', () => {
  const limiter = new FixedWindowRateLimiter(1, 60_000, 3);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(limiter.allow(`client-${index}`, 1_000), true);
    assert.ok(limiter.trackedSubjects <= 3);
  }
  assert.equal(limiter.trackedSubjects, 3);
});
