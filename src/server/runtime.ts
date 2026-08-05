import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RuntimeState {
  pid: number;
  host: string;
  port: number;
  url: string;
  dataDir: string;
  startedAt: string;
}

export function dataDirectory(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "model-verity");
}

export function runtimeFile(dataDir = dataDirectory()): string {
  return join(dataDir, "runtime.json");
}

export async function readRuntime(dataDir = dataDirectory()): Promise<RuntimeState | null> {
  try {
    return JSON.parse(await readFile(runtimeFile(dataDir), "utf8")) as RuntimeState;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function writeRuntime(state: RuntimeState): Promise<void> {
  const file = runtimeFile(state.dataDir);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

export async function removeRuntime(dataDir = dataDirectory()): Promise<void> {
  await rm(runtimeFile(dataDir), { force: true });
}
