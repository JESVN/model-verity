#!/usr/bin/env node
import openBrowser from "open";
import { startServer } from "../server/index.js";
import { VERSION } from "../version.js";
import {
  dataDirectory,
  processExists,
  readRuntime,
  removeRuntime,
  type RuntimeState,
} from "../server/runtime.js";

function usage(): void {
  console.log(`model-verity ${VERSION}

Usage:
  model-verity start [--host 127.0.0.1] [--port 8787]
  model-verity stop
  model-verity status [--json]
  model-verity open
  model-verity --help

The server is foreground by default. Press Ctrl+C to stop it.`);
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parsePort(raw: string | undefined): number {
  if (raw == null) return 8787;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return value;
}

async function liveState(): Promise<RuntimeState | null> {
  const state = await readRuntime();
  if (!state) return null;
  if (processExists(state.pid) && await isModelVerityServer(state.url)) return state;
  await removeRuntime(state.dataDir);
  return null;
}

async function isModelVerityServer(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
    const payload = await response.json() as { service?: string };
    return response.ok && payload.service === "model-verity";
  } catch {
    return false;
  }
}

async function commandStart(args: string[]): Promise<void> {
  const current = await liveState();
  if (current) throw new Error(`already running (pid ${current.pid}, ${current.url})`);
  const host = option(args, "--host") ?? "127.0.0.1";
  const port = parsePort(option(args, "--port"));
  if (host === "0.0.0.0" || host === "::") {
    console.warn("warning: exposing model-verity beyond localhost; protect it with authentication and a firewall");
  }
  const running = await startServer({ host, port });
  console.log(`model-verity listening on ${running.state.url}`);
  console.log(`data directory: ${running.state.dataDir}`);
  console.log("press Ctrl+C to stop");

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`\nreceived ${signal}; stopping`);
    await running.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function commandStatus(args: string[]): Promise<void> {
  const state = await liveState();
  const body = state
    ? { status: "running", ...state }
    : { status: "stopped", dataDir: dataDirectory() };
  if (args.includes("--json")) console.log(JSON.stringify(body));
  else if (state) {
    console.log(`running\npid: ${state.pid}\nurl: ${state.url}\ndata directory: ${state.dataDir}\nstarted: ${state.startedAt}`);
  } else console.log(`stopped\ndata directory: ${body.dataDir}`);
}

async function waitForExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processExists(pid);
}

async function commandStop(): Promise<void> {
  const state = await liveState();
  if (!state) {
    console.log("already stopped");
    return;
  }
  if (state.pid === process.pid) throw new Error("refusing to stop current process");
  try {
    process.kill(state.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (!(await waitForExit(state.pid))) throw new Error(`process ${state.pid} did not stop within 5 seconds`);
  await removeRuntime(state.dataDir);
  console.log(`stopped pid ${state.pid}`);
}

async function commandOpen(): Promise<void> {
  const state = await liveState();
  if (!state) throw new Error("model-verity is not running; run `model-verity start` first");
  if (process.env.MODEL_VERITY_NO_BROWSER === "1") {
    console.log(state.url);
    return;
  }
  await openBrowser(state.url, { wait: false });
  console.log(`opened ${state.url}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === "--help" || command === "-h" || command === "help") return usage();
  if (command === "--version" || command === "-v") return console.log(VERSION);
  const rest = args.slice(1);
  if (command === "start") return commandStart(rest);
  if (command === "status") return commandStatus(rest);
  if (command === "stop") return commandStop();
  if (command === "open") return commandOpen();
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`model-verity: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
