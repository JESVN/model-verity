import { endpoint, fetchJson, modelIds, type OneWordRequest, type OneWordResponse, type ProviderAdapter } from "./types.js";

export const anthropicMessagesAdapter: ProviderAdapter = {
  id: "anthropic-messages",
  async listModels(request) {
    const basePath = new URL(request.baseUrl).pathname.replace(/\/+$/, "");
    const result = await fetchJson(endpoint(request.baseUrl, basePath.endsWith("/v1") ? "models" : "v1/models"), {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        "x-api-key": request.apiKey,
        "anthropic-version": "2023-06-01",
        ...request.headers,
      },
      signal: request.signal,
    }, request.timeoutMs ?? 20_000);
    return modelIds(result.body);
  },
  async complete(request: OneWordRequest): Promise<OneWordResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: false,
    };
    if (!request.disableReasoning) body.thinking = { type: "enabled", budget_tokens: Math.max(1024, request.maxTokens) };
    const basePath = new URL(request.baseUrl).pathname.replace(/\/+$/, "");
    const result = await fetchJson(endpoint(request.baseUrl, basePath.endsWith("/v1") ? "messages" : "v1/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": request.apiKey,
        "anthropic-version": "2023-06-01",
        ...request.headers,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    }, request.timeoutMs);
    const content = Array.isArray(result.body?.content) ? result.body.content : [];
    const text = content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("");
    const thinkingSeen = content.some((part: any) => part?.type === "thinking" || part?.type === "redacted_thinking");
    return {
      text,
      latencyMs: result.latencyMs,
      responseModel: typeof result.body?.model === "string" ? result.body.model : undefined,
      usage: {
        inputTokens: result.body?.usage?.input_tokens,
        outputTokens: result.body?.usage?.output_tokens,
      },
      reasoningDisabled: request.disableReasoning && !thinkingSeen,
      raw: result.body,
    };
  },
};
