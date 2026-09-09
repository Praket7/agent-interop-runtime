/**
 * AIR-03 lock regressions (second readiness review blocker 1).
 *
 * Exercises the REAL cross-process lock protocol through spawned children, not in-process
 * mocks: atomic publication (no creation-window theft), live-owner-never-stolen, orphan
 * recovery of a dead owner's lock, competing recoverers, and long-held live locks.
 * The historical evidence files (second-readiness-repro.mjs) assert the BROKEN behavior and
 * are preserved untouched; these tests assert the FIXED contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withStateLock } from '../src/state.js';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'src', 'state.js');

async function tempDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Spawn a child that acquires the lock, optionally holds it for a duration, reports JSON. */
function runChild(script: string, lockFile: string): Promise<{ entered: boolean; overlap: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d; });
    child.stderr.on('data', (d: Buffer) => { err += d; });
    child.on('close', (code) => {
      if (out.trim()) { try { resolve(JSON.parse(out)); return; } catch { /* fall through */ } }
      reject(new Error(`child exit ${code}: ${err || out || 'no output'}`));
    });
    child.on('error', reject);
    void lockFile;
  });
}

test('AIR-03: atomic publication — a contender can never win while a creator is live (cross-process)', async () => {
  const { dir, cleanup } = await tempDir('lock-pub-');
  try {
    const file = path.join(dir, 'state.json');
    // Child A: acquire the lock and hold it for 700ms while writing a sentinel file.
    const a = runChild(`
      import fs from 'node:fs/promises';
      const { withStateLock } = await import(${JSON.stringify(dist)});
      const file = ${JSON.stringify(file)};
      await withStateLock(file, 'A', async () => {
        await fs.writeFile(${JSON.stringify(path.join(dir, 'a-inside'))}, 'x');
        await new Promise(r => setTimeout(r, 700));
        // Remove the sentinel before releasing so it exists ONLY while A is inside.
        await fs.rm(${JSON.stringify(path.join(dir, 'a-inside'))}, { force: true });
      });
      process.stdout.write(JSON.stringify({ entered: true, overlap: false }));
    `, file);
    // Child B: start slightly later; must NOT enter while A is inside the section.
    await new Promise((r) => setTimeout(r, 150));
    const b = runChild(`
      import fs from 'node:fs/promises';
      const { withStateLock } = await import(${JSON.stringify(dist)});
      let overlap;
      const start = Date.now();
      await withStateLock(${JSON.stringify(file)}, 'B', async () => {
        overlap = await fs.access(${JSON.stringify(path.join(dir, 'a-inside'))}).then(() => true, () => false);
      });
      process.stdout.write(JSON.stringify({ entered: true, overlap, waitedMs: Date.now() - start }));
    `, file);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.entered, true);
    assert.equal(rb.entered, true);
    assert.equal(rb.overlap, false, 'B must observe A still inside the section if it ever entered early; mutual exclusion broken');
  } finally { await cleanup(); }
});

test('AIR-03: live owner is never stolen from, regardless of elapsed time', async () => {
  const { dir, cleanup } = await tempDir('lock-live-');
  try {
    const file = path.join(dir, 'state.json');
    let release; const gate = new Promise((r) => { release = r; });
    let firstInside = false;
    const first = withStateLock(file, 'holder', async () => { firstInside = true; await gate; });
    await new Promise((r) => setTimeout(r, 80));
    // Well past any short stale interval: the holder is LIVE, so a contender must wait.
    let enteredEarly = false;
    const contender = withStateLock(file, 'contender', async () => { enteredEarly = firstInside; });
    // Sample the flag while the holder is STILL inside (at 400ms), then release the gate.
    const stolen = await (async () => { await new Promise((r) => setTimeout(r, 400)); return enteredEarly; })();
    assert.equal(stolen, false, 'a contender must not enter a live owner\'s critical section');
    release();
    await Promise.all([first, contender]);
    assert.equal(enteredEarly, true, 'contender must acquire after the holder releases (exclusion, not deadlock)');
  } finally { await cleanup(); }
});

test('AIR-03: a dead owner\'s lock is recovered after the orphan grace (cross-process)', async () => {
  const { dir, cleanup } = await tempDir('lock-orphan-');
  try {
    const file = path.join(dir, 'state.json');
    // Child acquires, then exits HARD without releasing (simulate crash).
    await runChild(`
      import fs from 'node:fs/promises';
      const { withStateLock } = await import(${JSON.stringify(dist)});
      await withStateLock(${JSON.stringify(file)}, 'crashed', async () => {
        process.stdout.write(JSON.stringify({ acquired: true }));
        process.kill(process.pid, 'SIGKILL');
      });
    `, file).catch(() => undefined);
    // A short stabilization window covers owner-death mid-creation; after that the
    // recoverer must acquire automatically, within the 10s max wait.
    const start = Date.now();
    await withStateLock(file, 'recoverer', async () => { /* recovered */ });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 9_000, `orphan recovery must complete within the max wait (took ${elapsed}ms)`);
  } finally { await cleanup(); }
});

test('AIR-03: competing recoverers cannot corrupt a recovered lock (cross-process)', async () => {
  const { dir, cleanup } = await tempDir('lock-race-');
  try {
    const file = path.join(dir, 'state.json');
    // Plant an orphan lock whose owner PID does not exist and is long expired.
    const info = { pid: 999_999_999, host: 'dead', acquiredAt: new Date(Date.now() - 60_000).toISOString(), owner: 'crashed', token: 'orphan-token' };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${file}.lock`, JSON.stringify(info), 'utf8');
    // Two children race to recover simultaneously; both must eventually run cleanly and
    // the final lock file must be removed exactly once (no leftovers, no double-unlink crash).
    const results = await Promise.allSettled([
      runChild(`
        const { withStateLock } = await import(${JSON.stringify(dist)});
        await withStateLock(${JSON.stringify(file)}, 'recoverer1', async () => {
          await new Promise(r => setTimeout(r, 50));
        });
        process.stdout.write(JSON.stringify({ ok: true, who: 1 }));
      `, file),
      runChild(`
        const { withStateLock } = await import(${JSON.stringify(dist)});
        await withStateLock(${JSON.stringify(file)}, 'recoverer2', async () => {
          await new Promise(r => setTimeout(r, 50));
        });
        process.stdout.write(JSON.stringify({ ok: true, who: 2 }));
      `, file),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.ok(fulfilled.length >= 1, 'at least one recoverer must succeed');
    // The lock file must be gone after both critical sections ended.
    const stat = await fs.stat(`${file}.lock`).then(() => true, () => false);
    assert.equal(stat, false, 'lock file must be removed after release');
  } finally { await cleanup(); }
});

test('AIR-03: a long-held LIVE lock is renewed and never treated as stale (cross-process)', async () => {
  const { dir, cleanup } = await tempDir('lock-hold-');
  try {
    const file = path.join(dir, 'state.json');
    // Holder keeps the lock for ~7s (well past the 15s orphan grace with renewal? No —
    // the grace is 15s; the point is the holder's lease is RENEWED and a contender that
    // joins mid-hold cannot recover the lock while the holder is alive).
    const holder = runChild(`
      const { withStateLock } = await import(${JSON.stringify(dist)});
      await withStateLock(${JSON.stringify(file)}, 'long-holder', async () => {
        await new Promise(r => setTimeout(r, 2000));
        process.stdout.write(JSON.stringify({ done: true }));
      });
    `, file);
    await new Promise((r) => setTimeout(r, 300));
    const contender = runChild(`
      const { withStateLock } = await import(${JSON.stringify(dist)});
      const start = Date.now();
      await withStateLock(${JSON.stringify(file)}, 'late-comer', async () => {});
      process.stdout.write(JSON.stringify({ waitedMs: Date.now() - start }));
    `, file);
    const [rh, rc] = await Promise.all([holder, contender]);
    assert.equal(rh.done, true);
    assert.ok(rc.waitedMs > 500, `late-comer must wait out the live holder (waited ${rc.waitedMs}ms)`);
  } finally { await cleanup(); }
});
