import { anthropicMessagesAdapter } from "./anthropic.js";
import { openAICompatibleAdapter } from "./openai.js";
import { openAIResponsesAdapter } from "./openai-responses.js";
import type { AdapterId, ProviderAdapter } from "./types.js";

const adapters = new Map<AdapterId, ProviderAdapter>([
  [openAICompatibleAdapter.id, openAICompatibleAdapter],
  [openAIResponsesAdapter.id, openAIResponsesAdapter],
  [anthropicMessagesAdapter.id, anthropicMessagesAdapter],
]);

export function adapterFor(id: AdapterId): ProviderAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`unknown adapter: ${id}`);
  return adapter;
}

export function registerAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.id, adapter);
}
