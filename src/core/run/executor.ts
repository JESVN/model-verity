import type { PlannedSample } from "./planner.js";

export interface RetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
}
export interface RetryableError extends Error {
  retryable?: boolean;
  retryAfterMs?: number;
  status?: number;
}
export interface ExecutionProgress<T> {
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
  item: PlannedSample;
  result?: T;
  error?: Error;
}
export interface ExecuteOptions<T> {
  concurrency?: number;
  signal?: AbortSignal;
  retry?: RetryPolicy;
  circuitBreakAfter?: number;
  onProgress?: (progress: ExecutionProgress<T>) => void;
}
export interface ExecutionResult<T> {
  results: Map<string, T>;
  errors: Map<string, Error>;
  aborted: boolean;
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(abortError()); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal) timer.unref?.();
  });
}

export function isRetryable(error: unknown): boolean {
  const candidate = error as RetryableError;
  if (candidate.retryable != null) return candidate.retryable;
  return candidate.status === 408 || candidate.status === 429 || (candidate.status != null && candidate.status >= 500);
}

async function attempt<T>(
  item: PlannedSample,
  worker: (item: PlannedSample, signal?: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  policy: Required<RetryPolicy>,
): Promise<T> {
  let last: Error | undefined;
  for (let number = 1; number <= policy.maxAttempts; number += 1) {
    if (signal?.aborted) throw abortError();
    try {
      return await worker(item, signal);
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
      if (!isRetryable(error) || number === policy.maxAttempts) throw last;
      const retryAfter = (error as RetryableError).retryAfterMs;
      const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (number - 1));
      const randomFactor = 1 + (Math.random() * 2 - 1) * policy.jitter;
      await sleep(Math.max(retryAfter ?? 0, exponential * randomFactor), signal);
    }
  }
  throw last ?? new Error("retry exhausted");
}

export async function executePlan<T>(
  items: readonly PlannedSample[],
  worker: (item: PlannedSample, signal?: AbortSignal) => Promise<T>,
  options: ExecuteOptions<T> = {},
): Promise<ExecutionResult<T>> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("invalid concurrency");
  const policy: Required<RetryPolicy> = {
    maxAttempts: options.retry?.maxAttempts ?? 3,
    baseDelayMs: options.retry?.baseDelayMs ?? 500,
    maxDelayMs: options.retry?.maxDelayMs ?? 10_000,
    jitter: options.retry?.jitter ?? 0.2,
  };
  const circuitBreakAfter = options.circuitBreakAfter ?? 12;
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10) throw new Error("invalid maxAttempts");
  if (!Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0 || !Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) throw new Error("invalid retry delays");
  if (!Number.isFinite(policy.jitter) || policy.jitter < 0 || policy.jitter > 1) throw new Error("invalid retry jitter");
  if (!Number.isSafeInteger(circuitBreakAfter) || circuitBreakAfter < 1) throw new Error("invalid circuit breaker threshold");
  const results = new Map<string, T>();
  const errors = new Map<string, Error>();
  let cursor = 0;
  let completed = 0;
  let consecutiveFailures = 0;
  let circuitOpen = false;

  const run = async () => {
    while (!options.signal?.aborted && !circuitOpen) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      try {
        const result = await attempt(item, worker, options.signal, policy);
        results.set(item.id, result);
        consecutiveFailures = 0;
        completed += 1;
        options.onProgress?.({ completed, total: items.length, succeeded: results.size, failed: errors.size, item, result });
      } catch (error) {
        if (options.signal?.aborted || (error as Error).name === "AbortError") return;
        const failure = error instanceof Error ? error : new Error(String(error));
        errors.set(item.id, failure);
        consecutiveFailures += 1;
        completed += 1;
        options.onProgress?.({ completed, total: items.length, succeeded: results.size, failed: errors.size, item, error: failure });
        if (consecutiveFailures >= circuitBreakAfter) circuitOpen = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  if (circuitOpen) {
    for (const item of items) {
      if (!results.has(item.id) && !errors.has(item.id)) errors.set(item.id, new Error("circuit breaker opened"));
    }
  }
  return { results, errors, aborted: Boolean(options.signal?.aborted) };
}
