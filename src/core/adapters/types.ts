import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AdapterId = "openai-compatible" | "openai-responses" | "anthropic-messages";

export interface OneWordRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  disableReasoning: boolean;
  allowCompatibilityRetry?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OneWordResponse {
  text: string;
  latencyMs: number;
  responseModel?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  reasoningDisabled: boolean;
  raw?: unknown;
}

export interface ModelListRequest {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class AdapterError extends Error {
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
  constructor(message: string, options: { status?: number; retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "AdapterError";
    this.status = options.status;
    this.retryable = options.retryable ?? (options.status === 408 || options.status === 429 || (options.status != null && options.status >= 500));
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface ProviderAdapter {
  id: AdapterId;
  complete(request: OneWordRequest): Promise<OneWordResponse>;
  listModels(request: ModelListRequest): Promise<string[]>;
}

export function modelIds(body: any): string[] {
  const candidates = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : Array.isArray(body)
        ? body
        : [];
  const values: string[] = candidates.flatMap((item: any): string[] => {
    if (typeof item === "string") return [item];
    if (typeof item?.id === "string") return [item.id];
    if (typeof item?.name === "string") return [item.name];
    return [];
  });
  return [...new Set(values.map((value) => value.trim()).filter((value) => value && value.length <= 300))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 1000);
}

export function endpoint(baseUrl: string, path: string): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(path.replace(/^\//, ""), normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("provider URL must use http or https");
  return url.toString();
}

export function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export async function fetchJson(url: string, init: RequestInit, timeoutMs = 60_000): Promise<{ response: Response; body: any; latencyMs: number }> {
  await assertSafeProviderUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
  const relayAbort = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener("abort", relayAbort, { once: true });
  const started = performance.now();
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    const text = await response.text();
    let body: any;
    try { body = text ? JSON.parse(text) : {}; }
    catch { body = { text }; }
    if (!response.ok) {
      const message = body?.error?.message ?? body?.message ?? `provider returned HTTP ${response.status}`;
      throw new AdapterError(String(message), { status: response.status, retryAfterMs: retryAfterMs(response) });
    }
    return { response, body, latencyMs: performance.now() - started };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if (controller.signal.aborted && !init.signal?.aborted) throw new AdapterError("provider request timed out", { status: 408, retryable: true, cause: error });
    throw new AdapterError(error instanceof Error ? error.message : String(error), { retryable: false, cause: error });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", relayAbort);
  }
}

async function assertSafeProviderUrl(raw:string):Promise<void> {
  const url=new URL(raw);
  if(url.protocol!=="http:"&&url.protocol!=="https:")throw new AdapterError("provider URL must use http or https",{retryable:false});
  if(url.username||url.password)throw new AdapterError("provider URL userinfo is not allowed",{retryable:false});
  const addresses=isIP(url.hostname)?[{address:url.hostname}]:await lookup(url.hostname,{all:true,verbatim:true});
  if(addresses.some(({address})=>isPrivateAddress(address))&&process.env.MODEL_VERITY_ALLOW_PRIVATE_ENDPOINTS!=="1")throw new AdapterError("private provider endpoint blocked by SSRF policy",{retryable:false});
}
function isPrivateAddress(address:string):boolean {
  const value=address.toLowerCase();
  if(value==="::1"||value==="::"||value.startsWith("fe80:")||value.startsWith("fc")||value.startsWith("fd"))return true;
  const mapped=value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];const ip=mapped??value;
  if(!/^\d+\.\d+\.\d+\.\d+$/.test(ip))return false;
  const [a,b]=ip.split(".").map(Number);
  return a===10||a===127||a===0||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a>=224;
}
