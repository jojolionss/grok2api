import { Hono } from "hono";
import type { Env } from "../env";
import {
  selectBestTavilyKey,
  recordTavilyKeyFailure,
  resetTavilyKeyFailure,
} from "../repo/tavilyKeys";

const tavilyRoutes = new Hono<{ Bindings: Env }>();
const TAVILY_BASE = "https://api.tavily.com";
const MAX_RETRIES = 3;
const FAILOVER_CODES = [401, 429, 432, 433];

tavilyRoutes.all("/tavily/*", async (c) => {
  const path = c.req.path.replace(/^\/tavily/, "") || "/";
  const targetUrl = `${TAVILY_BASE}${path}`;

  const body = c.req.method !== "GET" && c.req.method !== "HEAD"
    ? await c.req.arrayBuffer()
    : null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const apiKey = await selectBestTavilyKey(c.env.DB);
    if (!apiKey) {
      return c.json({ error: "No available Tavily key in pool" }, 503);
    }

    const headers = new Headers(c.req.raw.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    headers.delete("host");
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ray");
    headers.delete("cf-ipcountry");

    try {
      const resp = await fetch(targetUrl, {
        method: c.req.method,
        headers,
        body,
      });

      // Success - reset failure count and return
      if (resp.ok) {
        await resetTavilyKeyFailure(c.env.DB, apiKey);
        return new Response(resp.body, {
          status: resp.status,
          headers: resp.headers,
        });
      }

      // Failover on specific errors
      if (FAILOVER_CODES.includes(resp.status)) {
        const text = await resp.text();
        await recordTavilyKeyFailure(c.env.DB, apiKey, resp.status, text.slice(0, 200));
        continue;
      }

      // Other errors - return as-is
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
      });
    } catch (e) {
      await recordTavilyKeyFailure(c.env.DB, apiKey, 0, e instanceof Error ? e.message : String(e));
    }
  }

  return c.json({ error: "All Tavily keys exhausted or unavailable" }, 503);
});

export { tavilyRoutes };
