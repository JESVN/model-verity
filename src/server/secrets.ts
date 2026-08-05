import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDirectory } from "./runtime.js";

const SERVICE = "model-verity";
interface SecretDocument { version: 1; salt: string; entries: Record<string, string> }
interface KeytarLike { getPassword(service: string, account: string): Promise<string | null>; setPassword(service: string, account: string, value: string): Promise<void>; deletePassword(service: string, account: string): Promise<boolean> }

async function keytar(): Promise<KeytarLike | null> {
  if (process.env.MODEL_VERITY_DISABLE_KEYCHAIN === "1") return null;
  try {
    const module = await import("keytar");
    return (module.default ?? module) as KeytarLike;
  } catch {
    return null;
  }
}

// Nonce, auth tag, ciphertext serialized as base64url with "." separators.
// The AES key is derived once per process from the constant master secret + salt
// instead of re-running the memory-hard KDF (scrypt ~50-60ms) on every get/set.
function encryptWithKey(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

function decryptWithKey(value: string, key: Buffer): string {
  const [ivRaw, tagRaw, dataRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !dataRaw) throw new Error("invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw, "base64url")), decipher.final()]).toString("utf8");
}

export class SecretStore {
  readonly dir: string;
  readonly file: string;
  readonly keyFile: string;
  // Derived AES key and decrypted document are stable for the process lifetime and
  // only change via this store's own writes, so we cache them to avoid re-running
  // the memory-hard KDF and repeatedly parsing the file on every read.
  private keyCache = new Map<string, Buffer>();
  private documentCache: SecretDocument | null = null;
  private masterSecretCache?: string;
  constructor(dataDir = dataDirectory()) {
    this.dir = join(dataDir, "secrets");
    this.file = join(this.dir, "secrets.enc.json");
    this.keyFile = join(this.dir, "master.key");
  }

  private masterSecret(): string {
    if (this.masterSecretCache !== undefined) return this.masterSecretCache;
    const secret = process.env.MODEL_VERITY_MASTER_KEY
      ?? (() => {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        if (!existsSync(this.keyFile)) writeFileSync(this.keyFile, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
        chmodSync(this.keyFile, 0o600);
        return readFileSync(this.keyFile, "utf8").trim();
      })();
    this.masterSecretCache = secret;
    return secret;
  }

  private keyFor(salt: Buffer): Buffer {
    const cacheKey = salt.toString("base64url");
    const cached = this.keyCache.get(cacheKey);
    if (cached) return cached;
    const key = scryptSync(this.masterSecret(), salt, 32);
    this.keyCache.set(cacheKey, key);
    return key;
  }

  private async readDocument(): Promise<SecretDocument> {
    if (this.documentCache) return this.documentCache;
    try {
      const document = JSON.parse(await readFile(this.file, "utf8")) as SecretDocument;
      this.documentCache = document;
      return document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const document: SecretDocument = { version: 1, salt: randomBytes(16).toString("base64url"), entries: {} };
      this.documentCache = document;
      return document;
    }
  }

  private async writeDocument(document: SecretDocument): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.file, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await chmod(this.file, 0o600);
    this.documentCache = document;
  }

  async backend(): Promise<"keychain" | "encrypted-file"> { return (await keytar()) ? "keychain" : "encrypted-file"; }

  async set(account: string, value: string): Promise<string> {
    if (!value) throw new Error("secret cannot be empty");
    const native = await keytar();
    if (native) {
      try {
        await native.setPassword(SERVICE, account, value);
        return `keychain:${account}`;
      } catch {
        // A loadable keytar can still fail at runtime (locked/unavailable keychain).
      }
    }
    const document = await this.readDocument();
    document.entries[account] = encryptWithKey(value, this.keyFor(Buffer.from(document.salt, "base64url")));
    await this.writeDocument(document);
    return `file:${account}`;
  }

  async get(reference: string): Promise<string | null> {
    const separator = reference.indexOf(":");
    const backend = reference.slice(0, separator);
    const account = reference.slice(separator + 1);
    if (!account) return null;
    if (backend === "keychain") return (await keytar())?.getPassword(SERVICE, account) ?? null;
    if (backend === "file") {
      const document = await this.readDocument();
      const encrypted = document.entries[account];
      return encrypted ? decryptWithKey(encrypted, this.keyFor(Buffer.from(document.salt, "base64url"))) : null;
    }
    return null;
  }

  async delete(reference: string): Promise<void> {
    const [backend, account] = reference.split(":", 2);
    if (backend === "keychain") { await (await keytar())?.deletePassword(SERVICE, account); return; }
    if (backend === "file") {
      const document = await this.readDocument();
      delete document.entries[account];
      await this.writeDocument(document);
    }
  }
}

export function maskSecret(value?: string | null): string {
  if (!value) return "未设置";
  if (value.length <= 8) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
