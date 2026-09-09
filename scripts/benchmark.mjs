/**
 * Runs the two-provider offline benchmark harness and prints a JSON report.
 * Usage: npx pnpm build && npx pnpm bench
 *
 * All "providers" are in-memory peers; no live provider is contacted. Token counts use
 * js-tiktoken o200k_base and are offline estimates, not native provider usage.
 */
import { runBenchmark } from '../test/benchmark/harness.js';

const result = await runBenchmark();
console.log(JSON.stringify(result, null, 2));
