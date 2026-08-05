type StoredProtocol = "openai-compatible" | "openai-responses" | "anthropic-messages";

export const VERIFICATION_PREFERENCES_KEY = "model-verity.verify-preferences.v1";

export interface VerificationPreferences {
  mode: "screening" | "paired";
  providerId: string;
  model: string;
  referenceId: string;
  profile: "quick" | "audit" | "full";
  referenceProviderId: string;
  referenceModel: string;
  targetProtocol: StoredProtocol;
  referenceProtocol: StoredProtocol;
  vendor: string;
  product: string;
  surface: string;
  referenceVendor: string;
  referenceProduct: string;
  referenceSurface: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function preferredItem<T extends { id: string }>(items: T[], savedId: unknown): T | undefined {
  return items.find((item) => item.id === savedId) ?? items[0];
}

export function preferredModel(models: string[] | undefined, savedModel: unknown): string {
  return models?.find((model) => model === savedModel) ?? models?.[0] ?? "";
}

function browserStorage(): StorageLike | undefined {
  return (globalThis as typeof globalThis & { localStorage?: StorageLike }).localStorage;
}

export function loadVerificationPreferences(storage?: StorageLike): Partial<VerificationPreferences> {
  const target = storage ?? browserStorage();
  if (!target) return {};
  try {
    const value = JSON.parse(target.getItem(VERIFICATION_PREFERENCES_KEY) ?? "null");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function saveVerificationPreferences(value: VerificationPreferences, storage?: StorageLike): void {
  const target = storage ?? browserStorage();
  if (!target) return;
  try {
    target.setItem(VERIFICATION_PREFERENCES_KEY, JSON.stringify(value));
  } catch {
    // Preferences must never block verification when browser storage is unavailable.
  }
}
