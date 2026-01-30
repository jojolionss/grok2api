import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context } from "hono";
import type { Env } from "../env";
import { requireApiAuth, type ApiAuthInfo } from "../auth";
import { getSettings } from "../settings";
import { dbFirst } from "../db";
import { validateApiKey } from "../repo/apiKeys";
import {
  selectBestTavilyKey,
  recordTavilyKeyFailure,
  resetTavilyKeyFailure,
} from "../repo/tavilyKeys";

type TavilyBindings = { Bindings: Env; Variables: { apiAuth: ApiAuthInfo } };
type TavilyContext = Context<TavilyBindings>;

const tavilyRoutes = new Hono<TavilyBindings>();
const TAVILY_BASE = "https://api.tavily.com";
const MAX_RETRIES = 3;
const FAILOVER_CODES = [401, 402, 429, 432, 433];
const ALLOWED_METHODS = ["GET", "POST", "OPTIONS"];
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

function normalizeApiKey(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed || null;
}

function bearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return normalizeApiKey(m?.[1] ?? null);
}

function authError(message: string, code: string): Record<string, unknown> {
  return { error: { message, type: "authentication_error", code } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type AuthResult =
  | { ok: true; auth: ApiAuthInfo }
  | { ok: false; status: number; body: Record<string, unknown> };

async function authenticateApiKey(c: TavilyContext, token: string | null): Promise<AuthResult> {
  const settings = await getSettings(c.env);
  const globalKey = normalizeApiKey(settings.grok.api_key ?? "");

  if (!token) {
    if (!globalKey) {
      const row = await dbFirst<{ c: number }>(
        c.env.DB,
        "SELECT COUNT(1) as c FROM api_keys WHERE is_active = 1",
      );
      if ((row?.c ?? 0) === 0) {
        return { ok: true, auth: { key: null, name: "Anonymous", is_admin: false } };
      }
    }
    return { ok: false, status: 401, body: authError("Missing authentication token", "missing_token") };
  }

  if (globalKey && token === globalKey) {
    return { ok: true, auth: { key: token, name: "Default Admin", is_admin: true } };
  }

  const keyInfo = await validateApiKey(c.env.DB, token);
  if (keyInfo) {
    return { ok: true, auth: { key: keyInfo.key, name: keyInfo.name, is_admin: false } };
  }

  return { ok: false, status: 401, body: authError("Invalid token", "invalid_token") };
}

function buildTavilyUrl(path: string, requestUrl: string, stripApiKey: boolean): string {
  const source = new URL(requestUrl);
  const target = new URL(`${TAVILY_BASE}${path}`);
  source.searchParams.forEach((value, key) => {
    if (stripApiKey && key === "api_key") return;
    target.searchParams.append(key, value);
  });
  return target.toString();
}

function buildProxyHeaders(source: Headers): Headers {
  // Allowlist approach - only forward safe headers to prevent cookie/secret leakage
  const ALLOWED_HEADERS = ["accept", "accept-language", "content-type", "user-agent"];
  const headers = new Headers();
  
  for (const name of ALLOWED_HEADERS) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  
  // Never forward content-length - let fetch compute it
  return headers;
}

interface ParsedBody {
  body: BodyInit | null;
  contentType: string | null;
  apiKeyFromBody: string | null;
  modified: boolean;
  tooLarge: boolean;
}

function checkContentLength(c: TavilyContext): boolean {
  const cl = c.req.header("Content-Length");
  if (cl) {
    const len = parseInt(cl, 10);
    if (!isNaN(len) && len > MAX_BODY_SIZE) return true;
  }
  return false;
}

async function parseBodyAndExtractApiKey(c: TavilyContext): Promise<ParsedBody> {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    return { body: null, contentType: null, apiKeyFromBody: null, modified: false, tooLarge: false };
  }

  // Early size check via Content-Length header
  if (checkContentLength(c)) {
    return { body: null, contentType: null, apiKeyFromBody: null, modified: false, tooLarge: true };
  }

  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    const raw = await c.req.arrayBuffer();
    if (raw.byteLength > MAX_BODY_SIZE) {
      return { body: null, contentType, apiKeyFromBody: null, modified: false, tooLarge: true };
    }
    return { body: raw, contentType, apiKeyFromBody: null, modified: false, tooLarge: false };
  }

  const text = await c.req.text();
  // Check text byte length (UTF-8)
  const byteLen = new TextEncoder().encode(text).length;
  if (byteLen > MAX_BODY_SIZE) {
    return { body: null, contentType, apiKeyFromBody: null, modified: false, tooLarge: true };
  }

  if (!text) {
    return { body: text, contentType, apiKeyFromBody: null, modified: false, tooLarge: false };
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const obj = { ...parsed };
      const hasApiKey = Object.prototype.hasOwnProperty.call(obj, "api_key");
      const hasApiKeyAlt = Object.prototype.hasOwnProperty.call(obj, "apiKey");
      const apiKeyFromBody = normalizeApiKey(
        typeof obj.api_key === "string" ? obj.api_key :
        typeof obj.apiKey === "string" ? obj.apiKey : null
      );
      
      if (hasApiKey) delete obj.api_key;
      if (hasApiKeyAlt) delete obj.apiKey;

      if (hasApiKey || hasApiKeyAlt) {
        return {
          body: JSON.stringify(obj),
          contentType: "application/json",
          apiKeyFromBody,
          modified: true,
          tooLarge: false,
        };
      }
    }
  } catch {
    // Invalid JSON, pass through
  }

  return { body: text, contentType, apiKeyFromBody: null, modified: false, tooLarge: false };
}

async function proxyTavily(
  c: TavilyContext,
  targetUrl: string,
  init: { method: string; headers: Headers; body: BodyInit | null },
): Promise<Response> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const apiKey = await selectBestTavilyKey(c.env.DB);
    if (!apiKey) {
      return c.json({ error: "No available Tavily key in pool" }, 503);
    }

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);

    try {
      const resp = await fetch(targetUrl, {
        method: init.method,
        headers,
        body: init.body,
      });

      if (resp.ok) {
        await resetTavilyKeyFailure(c.env.DB, apiKey);
        return new Response(resp.body, { status: resp.status, headers: resp.headers });
      }

      if (FAILOVER_CODES.includes(resp.status)) {
        const text = await resp.text().catch(() => "");
        await recordTavilyKeyFailure(c.env.DB, apiKey, resp.status, text.slice(0, 200));
        continue;
      }

      return new Response(resp.body, { status: resp.status, headers: resp.headers });
    } catch (e) {
      await recordTavilyKeyFailure(c.env.DB, apiKey, 0, e instanceof Error ? e.message : String(e));
    }
  }

  return c.json({ error: "All Tavily keys exhausted or unavailable" }, 503);
}

function mcpError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const MCP_TOOL = {
  name: "tavily.search",
  description: "Search the web via Tavily API",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      search_depth: { type: "string", enum: ["basic", "advanced"] },
      max_results: { type: "number" },
      include_answer: { type: "boolean" },
      include_images: { type: "boolean" },
      include_raw_content: { type: "boolean" },
      include_domains: { type: "array", items: { type: "string" } },
      exclude_domains: { type: "array", items: { type: "string" } },
    },
    required: ["query"],
  },
};

// CORS for all routes
tavilyRoutes.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 86400,
  }),
);

// Authentication for /tavily/* routes
tavilyRoutes.use("/tavily/*", requireApiAuth);

// Tavily proxy - requires API key authentication
tavilyRoutes.all("/tavily/*", async (c) => {
  // Method validation
  if (!ALLOWED_METHODS.includes(c.req.method)) {
    return c.json({ error: "Method not allowed" }, 405);
  }

  const path = c.req.path.replace(/^\/tavily/, "") || "/";
  
  // Path validation
  if (path.includes("..") || path.includes("//")) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const targetUrl = buildTavilyUrl(path, c.req.url, true);
  const body = c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS"
    ? await c.req.arrayBuffer()
    : null;

  // Body size validation
  if (body && body.byteLength > MAX_BODY_SIZE) {
    return c.json({ error: "Request too large" }, 413);
  }

  const headers = buildProxyHeaders(c.req.raw.headers);
  return proxyTavily(c, targetUrl, { method: c.req.method, headers, body });
});

// /search endpoint - TavilyProxyManager compatible
// Supports api_key in: Authorization header, query param, or JSON body
tavilyRoutes.all("/search", async (c) => {
  // Method validation
  if (!ALLOWED_METHODS.includes(c.req.method)) {
    return c.json({ error: "Method not allowed" }, 405);
  }

  const queryKey = normalizeApiKey(new URL(c.req.url).searchParams.get("api_key"));
  const parsed = await parseBodyAndExtractApiKey(c);

  // Body size validation (early check in parseBodyAndExtractApiKey)
  if (parsed.tooLarge) {
    return c.json({ error: "Request too large" }, 413);
  }

  const token = bearerToken(c.req.header("Authorization") ?? null) || queryKey || parsed.apiKeyFromBody;

  const auth = await authenticateApiKey(c, token);
  if (!auth.ok) return c.json(auth.body, 401);
  c.set("apiAuth", auth.auth);

  const targetUrl = buildTavilyUrl("/search", c.req.url, true);
  const headers = buildProxyHeaders(c.req.raw.headers);
  
  if (parsed.modified) {
    headers.set("Content-Type", "application/json");
  }

  return proxyTavily(c, targetUrl, { method: c.req.method, headers, body: parsed.body });
});

// /mcp endpoint - MCP JSON-RPC for AI tool integration
tavilyRoutes.post("/mcp", async (c) => {
  // Body size check before parsing
  if (checkContentLength(c)) {
    return c.json(mcpError(null, -32600, "Request too large"), 413);
  }

  const queryKey = normalizeApiKey(new URL(c.req.url).searchParams.get("api_key"));
  
  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json(mcpError(null, -32700, "Invalid JSON"), 400);
  }

  const id = (payload?.id ?? null) as string | number | null;

  // Extract api_key from various locations in MCP payload
  let payloadApiKey: string | null = null;
  if (isRecord(payload)) {
    if (typeof payload.api_key === "string") {
      payloadApiKey = normalizeApiKey(payload.api_key);
    } else if (isRecord(payload.params)) {
      if (typeof payload.params.api_key === "string") {
        payloadApiKey = normalizeApiKey(payload.params.api_key);
      } else if (isRecord(payload.params.arguments) && typeof payload.params.arguments.api_key === "string") {
        payloadApiKey = normalizeApiKey(payload.params.arguments.api_key);
      }
    }
  }

  const token = bearerToken(c.req.header("Authorization") ?? null) || queryKey || payloadApiKey;

  const auth = await authenticateApiKey(c, token);
  if (!auth.ok) {
    return c.json(mcpError(id, 401, "Authentication failed"), 401);
  }
  c.set("apiAuth", auth.auth);

  if (!payload || typeof payload !== "object") {
    return c.json(mcpError(id, -32600, "Invalid request"), 400);
  }

  const method = typeof payload.method === "string" ? payload.method : "";

  // tools/list - list available tools
  if (method === "tools/list") {
    return c.json({ jsonrpc: "2.0", id, result: { tools: [MCP_TOOL] } });
  }

  // tools/call - execute a tool
  if (method === "tools/call") {
    const params = isRecord(payload.params) ? payload.params : {};
    const name = typeof params.name === "string" ? params.name : "";
    
    if (!["tavily.search", "tavily_search", "search"].includes(name)) {
      return c.json(mcpError(id, -32601, "Unknown tool"), 404);
    }

    const args = isRecord(params.arguments) ? { ...params.arguments } : {};
    // Remove api_key from arguments before sending to Tavily
    if (typeof args.api_key === "string") delete args.api_key;

    const body = JSON.stringify(args);
    const headers = new Headers({ "Content-Type": "application/json" });
    const resp = await proxyTavily(c, `${TAVILY_BASE}/search`, { method: "POST", headers, body });

    const text = await resp.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Keep raw text if not JSON
    }

    if (!resp.ok) {
      return c.json(mcpError(id, resp.status, "Upstream error"), 502);
    }

    return c.json({ jsonrpc: "2.0", id, result: { content: [{ type: "json", json: data }] } });
  }

  return c.json(mcpError(id, -32601, "Method not found"), 404);
});

export { tavilyRoutes };
