import type { Env } from "../env";
import { dbAll, dbFirst, dbRun } from "../db";
import { nowMs } from "../utils/time";

export interface TavilyKeyRow {
  key: string;
  alias: string;
  total_quota: number;
  used_quota: number;
  is_active: number;
  is_invalid: number;
  invalid_reason: string | null;
  last_used_at: number | null;
  last_sync_at: number | null;
  failed_count: number;
  last_failure_reason: string | null;
  tags: string;
  note: string;
  created_at: number;
}

export interface TavilyKeyInfo {
  key: string;
  alias: string;
  totalQuota: number;
  usedQuota: number;
  remainingQuota: number;
  isActive: boolean;
  isInvalid: boolean;
  invalidReason: string | null;
  status: string;
  lastUsedAt: number | null;
  lastSyncAt: number | null;
  failedCount: number;
  lastFailureReason: string | null;
  tags: string[];
  note: string;
  createdAt: number;
}

export interface TavilySyncProgress {
  running: boolean;
  current: number;
  total: number;
  success: number;
  failed: number;
  updated_at: number;
}

const MAX_FAILURES = 3;

function parseTags(tagsJson: string): string[] {
  try {
    const v = JSON.parse(tagsJson) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function getStatus(row: TavilyKeyRow): string {
  if (row.is_invalid) return "失效";
  if (!row.is_active) return "禁用";
  const remaining = row.total_quota - row.used_quota;
  if (remaining <= 0) return "已耗尽";
  if (row.failed_count >= MAX_FAILURES) return "错误";
  if (!row.last_used_at) return "未使用";
  return "正常";
}

export function tavilyKeyRowToInfo(row: TavilyKeyRow): TavilyKeyInfo {
  const remaining = Math.max(0, row.total_quota - row.used_quota);
  return {
    key: row.key,
    alias: row.alias,
    totalQuota: row.total_quota,
    usedQuota: row.used_quota,
    remainingQuota: remaining,
    isActive: Boolean(row.is_active),
    isInvalid: Boolean(row.is_invalid),
    invalidReason: row.invalid_reason,
    status: getStatus(row),
    lastUsedAt: row.last_used_at,
    lastSyncAt: row.last_sync_at,
    failedCount: row.failed_count,
    lastFailureReason: row.last_failure_reason,
    tags: parseTags(row.tags),
    note: row.note ?? "",
    createdAt: row.created_at,
  };
}

export async function listTavilyKeys(db: Env["DB"]): Promise<TavilyKeyRow[]> {
  return dbAll<TavilyKeyRow>(
    db,
    `SELECT key, alias, total_quota, used_quota, is_active, is_invalid, invalid_reason,
            last_used_at, last_sync_at, failed_count, last_failure_reason, tags, note, created_at
     FROM tavily_keys ORDER BY created_at DESC`
  );
}

export interface AddTavilyKeysResult {
  added: number;
  skipped: number;
  invalid: string[];
}

const TAVILY_KEY_REGEX = /^tvly-[A-Za-z0-9_-]{8,64}$/;
const MAX_KEY_LENGTH = 128;
const MAX_KEYS_PER_BATCH = 500;

function isValidTavilyKey(key: string): boolean {
  return typeof key === "string" && key.length <= MAX_KEY_LENGTH && TAVILY_KEY_REGEX.test(key);
}

export async function addTavilyKeys(
  db: Env["DB"],
  keys: unknown[],
  aliasPrefix: string = ""
): Promise<AddTavilyKeysResult> {
  const now = nowMs();
  
  // Runtime type filter and dedup
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  
  for (const raw of keys) {
    if (typeof raw !== "string") continue;
    const k = raw.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    
    if (isValidTavilyKey(k)) {
      valid.push(k);
    } else {
      // Only store masked version for security
      invalid.push(k.length > 20 ? k.substring(0, 15) + "..." : k);
    }
  }
  
  if (!valid.length) {
    return { added: 0, skipped: 0, invalid };
  }
  
  // Limit batch size
  const keysToAdd = valid.slice(0, MAX_KEYS_PER_BATCH);

  // Chunk INSERT operations to avoid D1 batch limit (~100 statements)
  const CHUNK_SIZE = 50;
  let added = 0;

  for (let i = 0; i < keysToAdd.length; i += CHUNK_SIZE) {
    const chunk = keysToAdd.slice(i, i + CHUNK_SIZE);
    const stmts = chunk.map((k, idx) => {
      const alias = aliasPrefix ? `${aliasPrefix}-${String(i + idx + 1).padStart(3, "0")}` : "";
      return db
        .prepare(
          `INSERT OR IGNORE INTO tavily_keys(key, alias, total_quota, used_quota, is_active, is_invalid, failed_count, tags, note, created_at)
           VALUES(?, ?, 1000, 0, 1, 0, 0, '[]', '', ?)`
        )
        .bind(k, alias, now);
    });

    const results = await db.batch(stmts);
    added += results.filter((r) => r.meta.changes > 0).length;
  }

  const skipped = keysToAdd.length - added;
  return { added, skipped, invalid };
}

export async function deleteTavilyKeys(db: Env["DB"], keys: string[]): Promise<number> {
  const cleaned = keys.map((k) => k.trim()).filter(Boolean);
  if (!cleaned.length) return 0;

  const CHUNK_SIZE = 50; // D1 parameter limit safe
  let totalDeleted = 0;

  for (let i = 0; i < cleaned.length; i += CHUNK_SIZE) {
    const chunk = cleaned.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const before = await dbFirst<{ c: number }>(
      db,
      `SELECT COUNT(1) as c FROM tavily_keys WHERE key IN (${placeholders})`,
      chunk
    );
    await dbRun(db, `DELETE FROM tavily_keys WHERE key IN (${placeholders})`, chunk);
    totalDeleted += before?.c ?? 0;
  }

  return totalDeleted;
}

export async function updateTavilyKeyTags(
  db: Env["DB"],
  key: string,
  tags: string[]
): Promise<void> {
  const cleaned = tags.map((t) => t.trim()).filter(Boolean);
  await dbRun(db, "UPDATE tavily_keys SET tags = ? WHERE key = ?", [JSON.stringify(cleaned), key]);
}

export async function updateTavilyKeyNote(
  db: Env["DB"],
  key: string,
  note: string
): Promise<void> {
  await dbRun(db, "UPDATE tavily_keys SET note = ? WHERE key = ?", [note.trim(), key]);
}

export async function updateTavilyKeyActive(
  db: Env["DB"],
  key: string,
  isActive: boolean
): Promise<void> {
  await dbRun(db, "UPDATE tavily_keys SET is_active = ? WHERE key = ?", [isActive ? 1 : 0, key]);
}

export async function getAllTavilyTags(db: Env["DB"]): Promise<string[]> {
  const rows = await dbAll<{ tags: string }>(db, "SELECT tags FROM tavily_keys");
  const set = new Set<string>();
  for (const r of rows) {
    for (const t of parseTags(r.tags)) set.add(t);
  }
  return [...set].sort();
}

export async function selectBestTavilyKey(db: Env["DB"]): Promise<string | null> {
  // Get all candidates sorted by remaining quota DESC
  const candidates = await dbAll<{ key: string; remaining: number }>(
    db,
    `SELECT key, (total_quota - used_quota) as remaining 
     FROM tavily_keys
     WHERE is_active = 1 AND is_invalid = 0 AND failed_count < ?
       AND (total_quota - used_quota) > 0
     ORDER BY remaining DESC`,
    [MAX_FAILURES]
  );

  if (!candidates.length) return null;

  // Get keys with highest remaining quota (randomize among equals to prevent hot spots)
  const maxRemaining = candidates[0]!.remaining;
  const topCandidates = candidates.filter((c) => c.remaining === maxRemaining);

  // Random selection from top tier for fairness
  const selected = topCandidates[Math.floor(Math.random() * topCandidates.length)];
  return selected?.key ?? null;
}

export async function updateTavilyKeyUsage(
  db: Env["DB"],
  key: string,
  usage: { usedQuota?: number; totalQuota?: number }
): Promise<void> {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (typeof usage.usedQuota === "number") {
    parts.push("used_quota = ?");
    params.push(usage.usedQuota);
  }
  if (typeof usage.totalQuota === "number") {
    parts.push("total_quota = ?");
    params.push(usage.totalQuota);
  }

  if (parts.length) {
    parts.push("last_sync_at = ?");
    params.push(nowMs());
    params.push(key);
    await dbRun(db, `UPDATE tavily_keys SET ${parts.join(", ")} WHERE key = ?`, params);
  }
}

export async function markTavilyKeyInvalid(
  db: Env["DB"],
  key: string,
  reason: string
): Promise<void> {
  await dbRun(
    db,
    "UPDATE tavily_keys SET is_invalid = 1, invalid_reason = ?, is_active = 0 WHERE key = ?",
    [reason, key]
  );
}

export async function recordTavilyKeyFailure(
  db: Env["DB"],
  key: string,
  status: number,
  message: string
): Promise<void> {
  const reason = `${status}: ${message}`;

  await dbRun(
    db,
    "UPDATE tavily_keys SET failed_count = failed_count + 1, last_failure_reason = ? WHERE key = ?",
    [reason, key]
  );

  // Immediate marking based on status code (TavilyProxyManager style)
  if (status === 401) {
    // 401 = unauthorized - key is invalid
    await markTavilyKeyInvalid(db, key, "unauthorized");
  } else if (status === 402 || status === 429 || status === 432 || status === 433) {
    // 402/429/432/433 = rate limit or quota exhausted - mark as depleted
    await dbRun(db, "UPDATE tavily_keys SET used_quota = total_quota WHERE key = ?", [key]);
  }
}

export async function resetTavilyKeyFailure(db: Env["DB"], key: string): Promise<void> {
  await dbRun(
    db,
    "UPDATE tavily_keys SET failed_count = 0, last_failure_reason = NULL, last_used_at = ? WHERE key = ?",
    [nowMs(), key]
  );
}

export async function getTavilyStats(db: Env["DB"]): Promise<{
  total: number;
  active: number;
  invalid: number;
  exhausted: number;
  totalRemainingQuota: number;
}> {
  const rows = await listTavilyKeys(db);
  let active = 0;
  let invalid = 0;
  let exhausted = 0;
  let totalRemainingQuota = 0;

  for (const row of rows) {
    if (row.is_invalid) {
      invalid++;
      continue;
    }
    if (!row.is_active) continue;

    const remaining = row.total_quota - row.used_quota;
    if (remaining <= 0) {
      exhausted++;
    } else {
      active++;
      totalRemainingQuota += remaining;
    }
  }

  return { total: rows.length, active, invalid, exhausted, totalRemainingQuota };
}

export async function getTavilySyncProgress(db: Env["DB"]): Promise<TavilySyncProgress> {
  const row = await dbFirst<{
    running: number;
    current: number;
    total: number;
    success: number;
    failed: number;
    updated_at: number;
  }>(db, "SELECT running, current, total, success, failed, updated_at FROM tavily_sync_progress WHERE id = 1");

  return row
    ? {
        running: Boolean(row.running),
        current: row.current,
        total: row.total,
        success: row.success,
        failed: row.failed,
        updated_at: row.updated_at,
      }
    : { running: false, current: 0, total: 0, success: 0, failed: 0, updated_at: Date.now() };
}

export async function setTavilySyncProgress(
  db: Env["DB"],
  progress: Partial<TavilySyncProgress>
): Promise<void> {
  const now = nowMs();
  const parts: string[] = [];
  const params: unknown[] = [];

  if (typeof progress.running === "boolean") {
    parts.push("running = ?");
    params.push(progress.running ? 1 : 0);
  }
  if (typeof progress.current === "number") {
    parts.push("current = ?");
    params.push(progress.current);
  }
  if (typeof progress.total === "number") {
    parts.push("total = ?");
    params.push(progress.total);
  }
  if (typeof progress.success === "number") {
    parts.push("success = ?");
    params.push(progress.success);
  }
  if (typeof progress.failed === "number") {
    parts.push("failed = ?");
    params.push(progress.failed);
  }

  if (parts.length) {
    parts.push("updated_at = ?");
    params.push(now);
    await dbRun(db, `UPDATE tavily_sync_progress SET ${parts.join(", ")} WHERE id = 1`, params);
  }
}

export interface TavilyKeyCheckResult {
  valid: boolean;
  usage?: number;
  limit?: number;
  reason?: string;
  status?: number;
}

export async function checkTavilyKeyUsage(key: string): Promise<TavilyKeyCheckResult> {
  const TIMEOUT_MS = 10000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch("https://api.tavily.com/usage", {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const status = resp.status;

    if (status === 200) {
      // 200 OK = key is valid, can get usage data
      const data = await resp.json();
      // Runtime validation
      if (typeof data !== "object" || data === null) {
        return { valid: false, reason: "invalid_response", status };
      }
      const keyData = (data as Record<string, unknown>).key;
      const usage = typeof (keyData as Record<string, unknown>)?.usage === "number"
        ? ((keyData as Record<string, unknown>).usage as number)
        : 0;
      const limit = typeof (keyData as Record<string, unknown>)?.limit === "number"
        ? ((keyData as Record<string, unknown>).limit as number)
        : 1000;
      return { valid: true, usage, limit, status };
    } else if (status === 401) {
      // 401 = unauthorized (key invalid or deactivated)
      return { valid: false, reason: "unauthorized", status };
    } else if (status === 429) {
      // 429 = rate limited, can't verify - mark as unverifiable (not valid)
      return { valid: false, reason: "rate_limited", status };
    } else if (status === 432 || status === 433) {
      // 432/433 = quota exhausted - key is valid but depleted
      return { valid: true, reason: "exhausted", status };
    } else {
      return { valid: false, reason: `http_${status}`, status };
    }
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof Error && e.name === "AbortError") {
      return { valid: false, reason: "timeout" };
    }
    return { valid: false, reason: "network_error" };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
