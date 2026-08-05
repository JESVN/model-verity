import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dataDirectory,
  removeRuntime,
  type RuntimeState,
  writeRuntime,
} from "./runtime.js";
import { Api, HttpError, sendJson } from "./api.js";
import { Repository } from "./db.js";
import { SecretStore } from "./secrets.js";
import { VERSION } from "../version.js";

export interface StartServerOptions {
  host?: string;
  port?: number;
  webRoot?: string;
  dataDir?: string;
  onListening?: (state: RuntimeState) => void;
}

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function safeAssetPath(webRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  const candidate = resolve(webRoot, relative);
  const root = resolve(webRoot);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

async function sendFile(res: ServerResponse, file: string, headOnly = false): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": extname(file) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    if (headOnly) res.end();
    else createReadStream(file).pipe(res);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function startServer(options: StartServerOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const dataDir = options.dataDir ?? dataDirectory();
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  const webRoot = options.webRoot ?? resolve(moduleDir, "../web");
  await access(join(webRoot, "index.html"));
  const repo = new Repository(dataDir);
  repo.recoverInterruptedRuns();
  const api = new Api(repo, new SecretStore(dataDir), dataDir);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (/%2e/i.test(req.url ?? "")) return json(res, 400, { error: "invalid_path" });
      const hostHeader = req.headers.host ?? `${host}:${port}`;
      const hostName = hostHeader.startsWith("[") ? hostHeader.slice(1, hostHeader.indexOf("]")) : hostHeader.split(":")[0];
      const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", host, ...(process.env.MODEL_VERITY_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim()).filter(Boolean)]);
      if (!allowedHosts.has(hostName)) return json(res, 421, { error: "misdirected_request" });
      const url = new URL(req.url ?? "/", `http://${hostHeader}`);
      if (url.pathname === "/api/health") {
        if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
        return json(res, 200, {
          ok: true,
          service: "model-verity",
          version: VERSION,
          maintenance: await access(join(dataDir, "maintenance.json")).then(() => true).catch(() => false),
          uptimeSeconds: Math.floor(process.uptime()),
        });
      }
      if (url.pathname.startsWith("/api/")) {
        try {
          const origin = req.headers.origin;
          if (origin) {
            const expected = `http://${req.headers.host ?? `${host}:${port}`}`;
            if (origin !== expected && origin !== expected.replace("http://", "https://")) throw new HttpError(403, "cross-origin API request denied");
          }
          if (await api.handle(req, res, url.pathname)) return;
        } catch (error) {
          if (error instanceof HttpError) {
            if(error.status===410)res.setHeader("Deprecation","true");
            if(error.status===410)res.setHeader("Sunset","2026-09-01T00:00:00Z");
            if(error.status===410)res.setHeader("Link",'</docs/v2-migration>; rel="deprecation"');
            return sendJson(res, error.status, { error: error.message });
          }
          throw error;
        }
        return json(res, 404, { error: "not_found" });
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" });
        return res.end();
      }
      const asset = safeAssetPath(webRoot, url.pathname);
      if (!asset) return json(res, 400, { error: "invalid_path" });
      const headOnly = req.method === "HEAD";
      if (url.pathname !== "/" && extname(url.pathname)) {
        if (await sendFile(res, asset, headOnly)) return;
        return json(res, 404, { error: "asset_not_found" });
      }
      if (await sendFile(res, join(webRoot, "index.html"), headOnly)) return;
      json(res, 404, { error: "web_build_missing" });
    } catch (error) {
      console.error("request failed", error instanceof Error ? error.message : error);
      if (!res.headersSent) json(res, 500, { error: "internal_error" });
      else res.end();
    }
  });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await api.shutdown();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    repo.close();
    await removeRuntime(dataDir);
  };

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const state: RuntimeState = {
    pid: process.pid,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    dataDir,
    startedAt: new Date().toISOString(),
  };
  await writeRuntime(state);
  options.onListening?.(state);

  return { server, state, close };
}
