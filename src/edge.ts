import { Hono } from "hono";
import type { EdgeEnv } from "./env";

const app = new Hono<{ Bindings: EdgeEnv }>();

// API routes - forward to backend via Service Binding
const API_PREFIXES = ["/v1/", "/api/", "/images/", "/tavily/"];
const API_EXACT = ["/health", "/search", "/mcp"];

app.all("*", async (c) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname;

  // Forward API requests to backend
  const isApiPrefix = API_PREFIXES.some((p) => pathname.startsWith(p) || pathname === p.slice(0, -1));
  const isApiExact = API_EXACT.includes(pathname);
  if (isApiPrefix || isApiExact) {
    return c.env.BACKEND.fetch(c.req.raw);
  }

  // Static routes handled by edge
  if (pathname === "/") {
    return c.redirect("/login", 302);
  }

  if (pathname === "/login") {
    return c.env.ASSETS.fetch(new Request(new URL("/login.html", c.req.url), c.req.raw));
  }

  if (pathname === "/manage") {
    return c.env.ASSETS.fetch(new Request(new URL("/admin.html", c.req.url), c.req.raw));
  }

  if (pathname.startsWith("/static/")) {
    if (pathname === "/static/_worker.js") return c.notFound();
    url.pathname = pathname.replace(/^\/static\//, "/");
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  }

  if (pathname === "/_worker.js") {
    return c.notFound();
  }

  // Fallback to assets
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
