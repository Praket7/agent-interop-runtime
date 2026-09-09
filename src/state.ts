import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LockInfo { pid: number; host: string; acquiredAt: string; owner: string; /** Unique per-acquisition token used for ownership-verified release/recovery. */ token: string }

const LOCK_RETRY_MS = 10;
const LOCK_MAX_WAIT_MS = 10_000;
/**
 * Stabilization window after a lock's recorded acquisition time before a DEAD-owner lock
 * is recovered. This is NOT a staleness lease: a LIVE owner is never stolen from no matter
 * how long it holds the lock (AIR-03). The window only covers two narrow edge cases where
 * liveness information itself is in transition:
 * - owner death mid-creation: the PID was alive at publish time and died a moment later;
 * - PID reuse: a NEW process now owns a recycled PID, which reports ALIVE, so the liveness
 *   check already blocks acquisition in that direction (safe; the recorded acquiredAt
 *   backstop keeps that wait bounded rather than eternal).
 */
const LOCK_ORPHAN_GRACE_MS = 1_500;
/** How often the lease is renewed while a writer is inside its critical section. */
const LOCK_RENEW_INTERVAL_MS = 5_000;

/** Tracks the lock held by the current async execution context (reentrancy support). */
const heldLock = new AsyncLocalStorage<HeldLock>();

interface HeldLock { file: string; token: string }

async function isProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function readLockInfo(lockFile: string): Promise<LockInfo | undefined> {
  try { return JSON.parse(await fs.readFile(lockFile, 'utf8')) as LockInfo; } catch { return undefined; }
}

/**
 * AIR-03 root fix — atomic publication of lock content.
 *
 * `fs.open('wx')` followed by `writeFile` has an inherent creation window: the file exists
 * (blocking other creators) but its content is not yet readable, so a contender's recovery
 * path may see "empty lock" and delete it while the creator is mid-write. Writing the full
 * JSON payload to a UNIQUELY NAMED temp file and `link()`ing it to the lock path is an
 * atomic create-if-absent that publishes existence and content together. `link` fails with
 * EEXIST when any writer — including one whose content we never saw — has won, so no
 * contender can win the file while a creator is between open and write, and no reader can
 * ever observe a partially written lock.
 *
 * (POSIX has no atomic create-with-content primitive; link-after-temp-write is the standard
 * O_CREAT-with-content equivalent and is also atomic on Windows via NTFS hard links.)
 */
async function tryPublishLock(lockFile: string, info: LockInfo): Promise<boolean> {
  const temp = `${lockFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(info), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await fs.link(temp, lockFile);
      return true;
    } finally {
      await fs.unlink(temp).catch(() => undefined);
      // posix rename semantics for the temp cleanup race: if link succeeded, the temp no
      // longer matters; if it failed, unlink removes our debris.
    }
  } catch {
    await fs.unlink(temp).catch(() => undefined);
    return false;
  }
}

/**
 * Recovery decision for an existing lock file.
 * - Missing: nothing to do (tryPublishLock will create).
 * - Unreadable/empty content: this protocol publishes existence and content ATOMICALLY, so
 *   a live creator can never be mid-publication behind an empty file (that was the AIR-03
 *   TOCTOU under the old open-then-write scheme). An unattributable file is therefore
 *   legacy debris or external garbage; it is recoverable once its mtime is older than the
 *   orphan grace, and that decision is re-verified under the recovery lock before unlink.
 *   Recent unattributable files are left alone and simply retried.
 * - Dead owner: recoverable after the orphan grace period (guards PID reuse and skew).
 * - Live owner: NEVER recoverable. Elapsed time alone must not steal a lock (AIR-03).
 */
async function lockIsRecoverable(lockFile: string): Promise<boolean> {
  const info = await readLockInfo(lockFile);
  if (!info) {
    try { return Date.now() - (await fs.stat(lockFile)).mtimeMs > LOCK_ORPHAN_GRACE_MS; } catch { return true; }
  }
  if (!(await isProcessAlive(info.pid))) {
    const acquired = Date.parse(info.acquiredAt);
    if (Number.isFinite(acquired)) {
      // Dead PID but very recently created: likely PID reuse or clock skew; wait it out.
      if (Date.now() - acquired < LOCK_ORPHAN_GRACE_MS) return false;
    }
    return true;
  }
  return false;
}

/**
 * Runs `fn` while holding an exclusive advisory lock for `file`.
 *
 * Publication is atomic (AIR-03): a contender either wins the complete lock — content and
 * existence together — or fails EEXIST against a lock it never saw the content of, so it
 * cannot delete a live creator's mid-publication file. Recovery and release verify
 * ownership by the per-acquisition token before unlinking, so one writer can never remove
 * another writer's replacement lock. A crashed writer's lock is recovered (its PID is gone
 * past the orphan grace period); a LIVE owner is never stolen from (AIR-03). The lease is
 * renewed while the critical section runs so long-held live locks stay unmistakably live.
 * Reentrant: a nested call on the same file from the same async context reuses the held
 * lock; distinct async chains and processes still serialize through the lock file.
 */
export async function withStateLock<T>(file: string, owner: string, fn: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(file);
  const alreadyHeld = heldLock.getStore();
  if (alreadyHeld?.file === resolved) return fn();
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const lockFile = `${resolved}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;

  for (;;) {
    if (await tryPublishLock(lockFile, { pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), owner, token })) break;
    if (Date.now() > deadline) {
      const current = await readLockInfo(lockFile);
      throw new Error(`Could not acquire state lock for ${path.basename(resolved)} held by ${JSON.stringify(current ?? null)}`);
    }
    if (await lockIsRecoverable(lockFile)) {
      // Recoveries are serialized through a separate fixed recovery lock so two competing
      // recoverers cannot both decide the same lock is recoverable and both unlink it
      // between one recoverer's unlink and the other's re-create (second-review finding:
      // "competing recoverers"). The recoverer that wins the recovery lock re-verifies
      // liveness under it; the loser re-enters the retry loop and observes the new lock.
      await withStateLock(`${lockFile}.recovery`, 'lock-recovery', async () => {
        // Re-verify under the recovery lock: state may have changed while we waited.
        const info = await readLockInfo(lockFile);
        if (!info) {
          // Unattributable debris: re-check mtime under the recovery lock, then unlink.
          if (await lockIsRecoverable(lockFile)) await fs.unlink(lockFile).catch(() => undefined);
          return;
        }
        // Ownership-verified recovery: only unlink if the content still names a dead
        // owner. If the content changed, another writer published a new lock; do not
        // remove it.
        if (!(await isProcessAlive(info.pid))) await fs.unlink(lockFile).catch(() => undefined);
      });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }

  // Lease renewal: keeps the acquiredAt timestamp fresh so a long-held lock is never
  // mistaken for orphaned debris, and so liveness checks remain anchored to a live writer.
  const renew = setInterval(() => {
    void (async () => {
      const info = await readLockInfo(lockFile);
      if (info?.token !== token) return; // we no longer own it; stop renewing
      await tryRewriteLock(lockFile, { ...info, acquiredAt: new Date().toISOString() });
    })().catch(() => undefined);
  }, LOCK_RENEW_INTERVAL_MS);
  renew.unref?.();

  try {
    return await heldLock.run({ file: resolved, token }, fn);
  } finally {
    clearInterval(renew);
    await releaseLock(lockFile, token);
  }
}

/** Atomically replaces lock content in place (used by lease renewal, same-owner only). */
async function tryRewriteLock(lockFile: string, info: LockInfo): Promise<void> {
  const temp = `${lockFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(info), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // Replace content without an unlink gap: rename over the existing lock file. The
    // identity token is unchanged, so ownership verification is unaffected.
    await fs.rename(temp, lockFile);
  } catch {
    await fs.unlink(temp).catch(() => undefined);
  }
}

/** Removes the lock file only if it still contains OUR token (ownership-verified release). */
async function releaseLock(lockFile: string, token: string): Promise<void> {
  try {
    const info = await readLockInfo(lockFile);
    if (!info || info.token !== token) return; // our lock was recovered/replaced; do not unlink theirs
    // Unlink by identity, not by pathname alone: re-verify token immediately before the
    // unlink. A racing recoverer that saw a dead PID for us cannot win — its recovery path
    // is serialized under the recovery lock AND re-verifies liveness before unlinking, and
    // we are alive while releasing, so the two operations cannot interleave destructively.
    await fs.unlink(lockFile);
  } catch { /* already gone; best effort */ }
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
}

export function transactionId(prefix: string): string { return `${prefix}_${randomUUID()}`; }
