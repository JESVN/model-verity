import { AdapterError, endpoint, fetchJson, modelIds, type OneWordRequest, type OneWordResponse, type ProviderAdapter } from "./types.js";

const unsupportedReasoningControls = new Set<string>();

export const openAICompatibleAdapter: ProviderAdapter = {
  id: "openai-compatible",
  async listModels(request) {
    const result = await fetchJson(endpoint(request.baseUrl, "models"), {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${request.apiKey}`,
        ...request.headers,
      },
      signal: request.signal,
    }, request.timeoutMs ?? 20_000);
    return modelIds(result.body);
  },
  async complete(request: OneWordRequest): Promise<OneWordResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: false,
    };
    const controlKey = new URL(request.baseUrl).origin + new URL(request.baseUrl).pathname;
    const useControls = request.disableReasoning && !unsupportedReasoningControls.has(controlKey);
    if (useControls) {
      body.reasoning = { enabled: false };
      body.reasoning_effort = "none";
      body.enable_thinking = false;
    }
    const send = () => fetchJson(endpoint(request.baseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.apiKey}`,
        ...request.headers,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    }, request.timeoutMs);
    let result;
    let controlsAccepted = useControls;
    try {
      result = await send();
    } catch (error) {
      const unsupported = error instanceof AdapterError && error.status === 400 && /unknown|unsupported|unrecognized|extra|reasoning[_ ]effort|enable[_ ]thinking/i.test(error.message);
      if (!useControls || !unsupported || request.allowCompatibilityRetry === false) throw error;
      delete body.reasoning;
      delete body.reasoning_effort;
      delete body.enable_thinking;
      unsupportedReasoningControls.add(controlKey);
      controlsAccepted = false;
      result = await send();
    }
    const content = result.body?.choices?.[0]?.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part: any) => part?.text ?? "").join("")
        : "";
    const reasoningSeen = typeof result.body?.choices?.[0]?.message?.reasoning_content === "string"
      || typeof result.body?.choices?.[0]?.message?.reasoning === "string";
    return {
      text,
      latencyMs: result.latencyMs,
      responseModel: typeof result.body?.model === "string" ? result.body.model : undefined,
      usage: {
        inputTokens: result.body?.usage?.prompt_tokens,
        outputTokens: result.body?.usage?.completion_tokens,
      },
      reasoningDisabled: request.disableReasoning && controlsAccepted && !reasoningSeen,
      raw: result.body,
    };
  },
};
