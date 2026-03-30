import type { ArgusRuntimeType } from '../config/env.js';

const DEFAULT_SEGMENT_SIZE_LIMIT = 150 * 1024;
const OPENAI_SEGMENT_SIZE_LIMIT = 256 * 1024;

export function getSegmentSizeLimitForRuntime(runtime: ArgusRuntimeType): number {
  return runtime === 'openai-responses' ? OPENAI_SEGMENT_SIZE_LIMIT : DEFAULT_SEGMENT_SIZE_LIMIT;
}
