import { AdapterError, endpoint, fetchJson, modelIds, type OneWordRequest, type OneWordResponse, type ProviderAdapter } from "./types.js";

const unsupportedReasoningControls = new Set<string>();

function visibleText(body: any): string {
  if (typeof body?.output_text === "string") return body.output_text;
  if (!Array.isArray(body?.output)) return "";
  return body.output
    .filter((item: any) => item?.type === "message" || Array.isArray(item?.content))
    .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    .filter((part: any) => part?.type === "output_text" || part?.type === "text")
    .map((part: any) => typeof part?.text === "string" ? part.text : typeof part?.text?.value === "string" ? part.text.value : "")
    .join("");
}

function reasoningSeen(body: any): boolean {
  const reasoningTokens = body?.usage?.output_tokens_details?.reasoning_tokens;
  if (typeof reasoningTokens === "number" && reasoningTokens > 0) return true;
  if (!Array.isArray(body?.output)) return false;
  return body.output.some((item: any) => {
    if (item?.type !== "reasoning") return false;
    if (typeof item?.content === "string") return Boolean(item.content.trim());
    if (Array.isArray(item?.content)) return item.content.some((part: any) => Boolean(part?.text?.trim?.() || part?.content?.trim?.()));
    if (Array.isArray(item?.summary)) return item.summary.some((part: any) => Boolean(part?.text?.trim?.()));
    return false;
  });
}

export const openAIResponsesAdapter: ProviderAdapter = {
  id: "openai-responses",
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
      instructions: request.system,
      input: request.user,
      temperature: request.temperature,
      max_output_tokens: request.maxTokens,
      stream: false,
      store: false,
    };
    const target = new URL(request.baseUrl);
    const controlKey = `${target.origin}${target.pathname}`;
    const useControls = request.disableReasoning && !unsupportedReasoningControls.has(controlKey);
    if (useControls) body.reasoning = { effort: "none" };
    const send = () => fetchJson(endpoint(request.baseUrl, "responses"), {
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
      const unsupported = error instanceof AdapterError
        && error.status === 400
        && /unknown|unsupported|unrecognized|extra|reasoning|effort/i.test(error.message);
      if (!useControls || !unsupported || request.allowCompatibilityRetry === false) throw error;
      delete body.reasoning;
      unsupportedReasoningControls.add(controlKey);
      controlsAccepted = false;
      result = await send();
    }
    return {
      text: visibleText(result.body),
      latencyMs: result.latencyMs,
      responseModel: typeof result.body?.model === "string" ? result.body.model : undefined,
      usage: {
        inputTokens: result.body?.usage?.input_tokens,
        outputTokens: result.body?.usage?.output_tokens,
      },
      reasoningDisabled: request.disableReasoning && controlsAccepted && !reasoningSeen(result.body),
      raw: result.body,
    };
  },
};
