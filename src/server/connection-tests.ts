import { randomUUID } from "node:crypto";
import { adapterFor } from "../core/adapters/registry.js";
import { AdapterError, type AdapterId } from "../core/adapters/types.js";
import type { Repository } from "./db.js";
import type { SecretStore } from "./secrets.js";

export type ConnectionTestStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface ConnectionTestResult {
  ok: boolean;
  category: "success" | "auth" | "rate_limit" | "timeout" | "network" | "server" | "invalid_response" | "cancelled" | "other";
  httpStatus?: number;
  retryAfterMs?: number;
  latencyMs?: number;
  responseModel?: string;
  reasoningDisabled?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
  message: string;
  advice: string;
}

export interface ConnectionTestSession {
  id: string;
  providerId: string;
  providerName: string;
  model: string;
  protocol: AdapterId;
  configuredAt: string;
  createdAt: string;
  finishedAt?: string;
  status: ConnectionTestStatus;
  result?: ConnectionTestResult;
}

interface InternalSession extends ConnectionTestSession { controller: AbortController; cleanupTimer?: NodeJS.Timeout }

export class ConnectionTestManager {
  private sessions = new Map<string, InternalSession>();
  private activeId: string | null = null;

  constructor(private repo: Repository, private secrets: SecretStore) {}

  active(): ConnectionTestSession | null {
    const session = this.activeId ? this.sessions.get(this.activeId) : undefined;
    return session ? this.public(session) : null;
  }

  isProviderActive(providerId: string): boolean {
    return this.active()?.providerId === providerId;
  }

  async create(providerId: string, model: string, selectedProtocol?: AdapterId): Promise<ConnectionTestSession> {
    if (this.activeId) throw new Error("another connection test is already active");
    if (this.repo.activeRunCount()) throw new Error("a sampling run is active");
    const provider = this.repo.getProvider(providerId);
    if (!provider) throw new Error("provider not found");
    if (!provider.models.includes(model)) throw new Error("model is not configured for provider");
    const controller = new AbortController();
    const session: InternalSession = {
      id: randomUUID(), providerId, providerName: provider.name, model,
      protocol: selectedProtocol ?? provider.protocol, configuredAt: provider.updatedAt,
      createdAt: new Date().toISOString(), status: "running", controller,
    };
    this.sessions.set(session.id, session);
    this.activeId = session.id;
    void this.execute(session, provider.baseUrl, provider.secretRef, provider.headers);
    return this.public(session);
  }

  get(id: string): ConnectionTestSession | undefined {
    const session = this.sessions.get(id);
    return session ? this.public(session) : undefined;
  }

  cancel(id: string): ConnectionTestSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.status === "running") session.controller.abort(new DOMException("Cancelled by user", "AbortError"));
    return this.public(session);
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.status === "running") session.controller.abort(new DOMException("Server shutting down", "AbortError"));
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    }
    while (this.activeId) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private async execute(session: InternalSession, baseUrl: string, secretRef: string, headers: Record<string, string>): Promise<void> {
    try {
      const apiKey = await this.secrets.get(secretRef);
      if (!apiKey) throw new AdapterError("provider API key unavailable", { status: 401, retryable: false });
      const response = await adapterFor(session.protocol).complete({
        baseUrl, apiKey, model: session.model,
        system: "Reply with exactly OK.", user: "Connection test.",
        temperature: 0, maxTokens: 8, disableReasoning: true,
        headers, signal: session.controller.signal, timeoutMs: 20_000,
      });
      if (!response.text.trim()) {
        session.status = "failed";
        session.result = {
          ok: false, category: "invalid_response", httpStatus: 200,
          latencyMs: response.latencyMs, responseModel: response.responseModel,
          reasoningDisabled: response.reasoningDisabled, usage: response.usage,
          message: "接口可达，但推理响应没有可见文本。",
          advice: "检查该模型是否返回 reasoning-only 内容，或 Base URL 与协议是否匹配。",
        };
      } else {
        session.status = "succeeded";
        session.result = {
          ok: true, category: "success", httpStatus: 200,
          latencyMs: response.latencyMs, responseModel: response.responseModel,
          reasoningDisabled: response.reasoningDisabled, usage: response.usage,
          message: response.reasoningDisabled ? "连接与最小推理请求成功。" : "连接成功，但未能确认 reasoning 已关闭。",
          advice: response.reasoningDisabled
            ? "该结果仅代表测试当时可连接，不证明模型身份。"
            : "正式验证会标记协议降级，建议确认供应商是否支持关闭 reasoning。",
        };
      }
    } catch (error) {
      const aborted = session.controller.signal.aborted;
      const adapterError = error instanceof AdapterError ? error : undefined;
      const status = adapterError?.status;
      const category: ConnectionTestResult["category"] = aborted ? "cancelled"
        : status === 401 || status === 403 ? "auth"
        : status === 429 ? "rate_limit"
        : status === 408 || /timed out/i.test(error instanceof Error ? error.message : String(error)) ? "timeout"
        : status != null && status >= 500 ? "server"
        : adapterError ? "network" : "other";
      session.status = aborted ? "cancelled" : "failed";
      session.result = {
        ok: false, category, httpStatus: status, retryAfterMs: adapterError?.retryAfterMs,
        message: redact(error instanceof Error ? error.message : String(error)),
        advice: adviceFor(category),
      };
    } finally {
      session.finishedAt = new Date().toISOString();
      if (this.activeId === session.id) this.activeId = null;
      session.cleanupTimer = setTimeout(() => this.sessions.delete(session.id), 5 * 60_000);
      session.cleanupTimer.unref?.();
    }
  }

  private public(session: InternalSession): ConnectionTestSession {
    const { controller: _controller, cleanupTimer: _cleanupTimer, ...safe } = session;
    return safe;
  }
}

function redact(message: string): string {
  return message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9._-]{8,}\b/gi, "[redacted]")
    .slice(0, 300);
}

function adviceFor(category: ConnectionTestResult["category"]): string {
  switch (category) {
    case "auth": return "检查已保存的 API Key、供应商权限和认证协议。";
    case "rate_limit": return "等待限流窗口结束后重试，并检查账户配额。";
    case "timeout": return "检查 Base URL、网络和供应商响应速度。";
    case "network": return "检查 DNS、TLS、代理和 Base URL。";
    case "server": return "供应商服务端异常；稍后重试或联系供应商。";
    case "cancelled": return "测试已取消，未形成连接结论。";
    default: return "核对 Base URL、协议和模型 ID 后重试。";
  }
}
