import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function discoverConnection(env = process.env) {
  const file = env.OPENCODE_SERVICE_FILE ?? join(homedir(), ".local/state/opencode/service.json");
  const service = env.OPENCODE_URL && env.OPENCODE_SERVER_PASSWORD ? {} : JSON.parse(await readFile(file, "utf8"));
  const url = env.OPENCODE_URL ?? service.url ?? "";
  const base = url.endsWith("/") ? url.slice(0, -1) : url;
  const password = env.OPENCODE_SERVER_PASSWORD ?? service.password;
  if (!base || !password) throw new Error("OpenCode service URL or credentials are unavailable");
  const authorization = "Basic " + Buffer.from((env.OPENCODE_SERVER_USERNAME ?? "opencode") + ":" + password).toString("base64");
  return { base, authorization };
}

export function createOpenCodeClient({ connection = discoverConnection, signal, fetchImpl = fetch }) {
  return async function request(path, options = {}) {
    const { base, authorization } = await connection();
    const signals = [AbortSignal.timeout(10000), signal, options.signal].filter(Boolean);
    const response = await fetchImpl(base + path, { ...options, signal: AbortSignal.any(signals), headers: {
      authorization, ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers ?? {}) } });
    if (!response.ok) throw new Error("OpenCode request failed (" + response.status + ")");
    if (response.status === 204) return null;
    return response.json();
  };
}
