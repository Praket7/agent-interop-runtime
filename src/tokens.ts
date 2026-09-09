/**
 * Named-tokenizer accounting shared by the handoff packet budget and the benchmark
 * harness. Tokenizer: js-tiktoken `o200k_base` — a fully offline BPE. Counts are an
 * offline estimate of prompt-size cost and must never be presented as native provider
 * usage reporting.
 */
import { getEncoding } from 'js-tiktoken';

export const TOKENIZER_NAME = 'js-tiktoken o200k_base';

const encoder = getEncoding('o200k_base');

export function countTokens(text: string): number {
  return encoder.encode(text).length;
}

export function countJsonTokens(value: unknown): number {
  return countTokens(JSON.stringify(value ?? null));
}
