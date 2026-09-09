/**
 * CI benchmark gate (audit §10 test strategy): runs the offline two-provider harness and
 * fails if any fixed task shows duplicate reads (cursor contract violations) or duplicate
 * provider-observed sends (delivery idempotency violations). Also asserts the tokenizer
 * label stays honest. Metrics deltas are reported, not enforced.
 */
import { runBenchmark } from '../test/benchmark/harness.ts';

const result = await runBenchmark();
const failures = [];
for (const task of result.tasks) {
  if (task.duplicateReads !== 0) failures.push(`${task.task}: ${task.duplicateReads} duplicate read(s)`);
  if (task.duplicateProviderSends !== 0) failures.push(`${task.task}: ${task.duplicateProviderSends} duplicate provider send(s)`);
  if (!(task.payloadBytes > 0 && task.tokens > 0)) failures.push(`${task.task}: metrics not populated`);
}
if (!/o200k_base/.test(result.tokenizer) || !/not native provider usage/.test(result.tokenizer)) failures.push('tokenizer label must stay honest');
if (failures.length) { console.error(`bench gate FAILED:\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log(`bench gate passed: ${result.tasks.length} tasks, 0 duplicate deliveries, tokenizer ${result.tokenizer}`);
