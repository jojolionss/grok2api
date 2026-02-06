let apiKey = '';
let cachedRows = [];
let displayRows = [];
let isSubmitting = false;
let syncPollTimer = null;

const tavilyFilterState = {
  search: '',
  status: 'all',
};

function q(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 14) return k;
  return `${k.slice(0, 10)}…${k.slice(-4)}`;
}

function fmtMs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '-';
  return new Date(Math.floor(n)).toLocaleString();
}

function normalizeRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  return {
    key: String(r.key || ''),
    alias: String(r.alias || ''),
    totalQuota: Number(r.totalQuota ?? 0),
    usedQuota: Number(r.usedQuota ?? 0),
    remainingQuota: Number(r.remainingQuota ?? 0),
    isActive: Boolean(r.isActive),
    isInvalid: Boolean(r.isInvalid),
    invalidReason: r.invalidReason ? String(r.invalidReason) : null,
    status: String(r.status || ''),
    lastUsedAt: r.lastUsedAt === null || r.lastUsedAt === undefined ? null : Number(r.lastUsedAt),
    lastSyncAt: r.lastSyncAt === null || r.lastSyncAt === undefined ? null : Number(r.lastSyncAt),
    failedCount: Number(r.failedCount ?? 0),
    lastFailureReason: r.lastFailureReason ? String(r.lastFailureReason) : null,
    tags: Array.isArray(r.tags) ? r.tags.map((t) => String(t || '').trim()).filter(Boolean) : [],
    note: String(r.note || ''),
    createdAt: Number(r.createdAt ?? 0),
  };
}

function extractErrorMessage(payload, fallback = '请求失败') {
  if (!payload) return fallback;
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  if (typeof payload.detail === 'string' && payload.detail.trim()) return payload.detail.trim();
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error.trim();
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
  if (payload.error && typeof payload.error.message === 'string' && payload.error.message.trim()) return payload.error.message.trim();
  return fallback;
}

async function parseJsonSafely(response) {
  try {
    return await response.json();
  } catch (e) {
    return null;
  }
}

function setLoading(loading) {
  const el = q('loading');
  if (!el) return;
  el.classList.toggle('hidden', !loading);
}

function setEmptyState(visible, text = '') {
  const el = q('empty-state');
  if (!el) return;
  if (text) el.textContent = text;
  el.classList.toggle('hidden', !visible);
}

function setText(id, value) {
  const el = q(id);
  if (el) el.textContent = String(value);
}

function updateStats(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  setText('tavily-stat-total', Number(s.total ?? 0));
  setText('tavily-stat-active', Number(s.active ?? 0));
  setText('tavily-stat-exhausted', Number(s.exhausted ?? 0));
  setText('tavily-stat-invalid', Number(s.invalid ?? 0));
  setText('tavily-stat-remaining', Number(s.totalRemainingQuota ?? 0));
}

function updateSyncIndicator(progress) {
  const wrap = q('tavily-sync-indicator');
  const text = q('tavily-sync-progress');
  if (!wrap || !text) return;
  const p = progress && typeof progress === 'object' ? progress : {};
  const running = Boolean(p.running);
  const current = Number(p.current ?? 0);
  const total = Number(p.total ?? 0);
  wrap.classList.toggle('hidden', !running);
  text.textContent = `${current}/${total}`;
}

function refreshFilterStateFromDom() {
  tavilyFilterState.search = String(q('tavily-search')?.value || '').trim().toLowerCase();
  tavilyFilterState.status = String(q('tavily-status-filter')?.value || 'all');
}

function matchStatus(row, status) {
  if (status === 'all') return true;
  const s = String(row.status || '');
  if (status === 'normal') return s === '正常';
  if (status === 'unused') return s === '未使用';
  if (status === 'error') return s === '错误';
  if (status === 'exhausted') return s === '已耗尽';
  if (status === 'disabled') return s === '禁用';
  if (status === 'invalid') return s === '失效';
  return true;
}

function applyTavilyFilters() {
  refreshFilterStateFromDom();
  const { search, status } = tavilyFilterState;
  displayRows = cachedRows.filter((row) => {
    if (!matchStatus(row, status)) return false;
    if (!search) return true;
    const haystack = `${row.alias} ${row.key} ${row.note} ${(row.tags || []).join(' ')}`.toLowerCase();
    return haystack.includes(search);
  });
  setText('tavily-filter-count', displayRows.length);
}

function statusPill(row) {
  const s = String(row.status || '');
  if (s === '正常') return '<span class="pill" style="background:#ecfdf5;color:#047857;border-color:#bbf7d0;">正常</span>';
  if (s === '未使用') return '<span class="pill" style="background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe;">未使用</span>';
  if (s === '已耗尽') return '<span class="pill" style="background:#fff7ed;color:#c2410c;border-color:#fed7aa;">已耗尽</span>';
  if (s === '失效') return '<span class="pill" style="background:#fef2f2;color:#b91c1c;border-color:#fecaca;">失效</span>';
  if (s === '禁用') return '<span class="pill pill-muted">禁用</span>';
  if (s === '错误') return '<span class="pill" style="background:#fefce8;color:#a16207;border-color:#fde68a;">错误</span>';
  return `<span class="pill pill-muted">${escapeHtml(s || '-')}</span>`;
}

function renderTags(tags) {
  const arr = Array.isArray(tags) ? tags : [];
  if (!arr.length) return '<span class="text-xs text-[var(--accents-5)]">-</span>';
  const chips = arr.slice(0, 6).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join(' ');
  const more = arr.length > 6 ? `<span class="text-xs text-[var(--accents-5)]">+${arr.length - 6}</span>` : '';
  return `<div class="flex flex-wrap gap-1">${chips}${more}</div>`;
}

function renderTable() {
  const body = q('tavily-table-body');
  if (!body) return;
  body.innerHTML = '';

  if (!cachedRows.length) {
    setEmptyState(true, '暂无 Tavily Key，请点击右上角导入。');
    return;
  }

  if (!displayRows.length) {
    setEmptyState(true, '没有符合筛选条件的 Tavily Key。');
    return;
  }

  setEmptyState(false);

  const html = displayRows.map((row) => {
    const quotaText = `${Number(row.remainingQuota || 0)} / ${Number(row.totalQuota || 0)}`;
    const note = row.note ? escapeHtml(row.note) : '<span class="text-xs text-[var(--accents-5)]">-</span>';
    const alias = row.alias ? escapeHtml(row.alias) : '<span class="text-xs text-[var(--accents-5)]">-</span>';
    const lastUsed = row.lastUsedAt ? fmtMs(row.lastUsedAt) : '-';
    const failed = Number(row.failedCount || 0);
    const failHint = row.lastFailureReason ? ` title="${escapeHtml(row.lastFailureReason)}"` : '';
    const activeLabel = row.isActive ? '禁用' : '启用';
    const activeClass = row.isActive ? 'geist-button-outline' : 'geist-button';

    return `
      <tr data-key="${escapeHtml(row.key)}">
        <td class="text-left">
          <div class="font-medium">${alias}</div>
          <div class="text-xs text-[var(--accents-5)]">创建：${escapeHtml(fmtMs(row.createdAt))}</div>
        </td>
        <td class="text-left">
          <div class="mono">${escapeHtml(maskKey(row.key))}</div>
          <button class="btn-link mt-1" data-action="copy">复制</button>
        </td>
        <td class="text-center">${statusPill(row)}</td>
        <td class="text-left mono">${escapeHtml(quotaText)}</td>
        <td class="text-center mono"${failHint}>${escapeHtml(String(failed))}</td>
        <td class="text-left">${renderTags(row.tags)}</td>
        <td class="text-left">${note}</td>
        <td class="text-center text-sm">${escapeHtml(lastUsed)}</td>
        <td class="text-center">
          <div class="flex items-center justify-center gap-2 flex-wrap">
            <button class="${activeClass} text-xs px-3" data-action="toggle">${escapeHtml(activeLabel)}</button>
            <button class="geist-button-outline text-xs px-3" data-action="edit">编辑</button>
            <button class="geist-button-danger text-xs px-3" data-action="delete">删除</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  body.innerHTML = html;
}

function bindTableEvents() {
  const body = q('tavily-table-body');
  if (!body) return;
  body.addEventListener('click', async (event) => {
    const btn = event.target && event.target.closest ? event.target.closest('button[data-action]') : null;
    if (!btn) return;
    const action = btn.getAttribute('data-action') || '';
    const tr = btn.closest('tr');
    const key = tr?.getAttribute('data-key') || '';
    if (!key) return;

    const row = cachedRows.find((r) => r.key === key);
    if (!row) return;

    if (action === 'copy') {
      await copyToClipboard(row.key);
      showToast('已复制', 'success');
      return;
    }
    if (action === 'toggle') {
      await updateTavilyKey(row.key, { is_active: !row.isActive });
      return;
    }
    if (action === 'edit') {
      openTavilyEditModal(row);
      return;
    }
    if (action === 'delete') {
      const ok = confirm(`确定删除该 Tavily Key？\n\n${maskKey(row.key)}`);
      if (!ok) return;
      await deleteTavilyKeys([row.key]);
      return;
    }
  });
}

async function copyToClipboard(text) {
  const value = String(text || '');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch (e) { }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

async function loadTavilyKeys() {
  apiKey = await ensureApiKey();
  if (apiKey === null) return;

  setLoading(true);
  setEmptyState(false);

  try {
    const res = await fetch('/api/v1/admin/tavily/keys', { headers: buildAuthHeaders(apiKey) });
    if (res.status === 401) return logout();
    const payload = await parseJsonSafely(res);
    if (!res.ok || payload?.success !== true) {
      throw new Error(extractErrorMessage(payload, '加载失败'));
    }
    const rows = Array.isArray(payload.data) ? payload.data : [];
    cachedRows = rows.map(normalizeRow);
    updateStats(payload.stats);
    updateSyncIndicator(payload.progress);
    applyTavilyFilters();
    renderTable();
  } catch (e) {
    showToast(`加载失败: ${e?.message || e}`, 'error');
  } finally {
    setLoading(false);
  }
}

function onTavilyFilterChange() {
  applyTavilyFilters();
  renderTable();
}

function resetTavilyFilters() {
  const search = q('tavily-search');
  const status = q('tavily-status-filter');
  if (search) search.value = '';
  if (status) status.value = 'all';
  applyTavilyFilters();
  renderTable();
}

function openTavilyImportModal() {
  const modal = q('tavily-import-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeTavilyImportModal() {
  const modal = q('tavily-import-modal');
  if (modal) modal.classList.add('hidden');
}

async function submitTavilyImport() {
  if (isSubmitting) return;
  apiKey = await ensureApiKey();
  if (apiKey === null) return;

  const keysText = String(q('tavily-import-keys')?.value || '').trim();
  const prefix = String(q('tavily-import-alias-prefix')?.value || '').trim();
  if (!keysText) {
    showToast('请粘贴至少 1 个 Key', 'error');
    return;
  }

  const keys = keysText
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const btn = q('btn-tavily-import-submit');
  if (btn) btn.textContent = '导入中...';
  isSubmitting = true;

  try {
    const res = await fetch('/api/v1/admin/tavily/keys', {
      method: 'POST',
      headers: { ...buildAuthHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys, alias_prefix: prefix }),
    });
    if (res.status === 401) return logout();
    const payload = await parseJsonSafely(res);
    if (!res.ok || payload?.success !== true) {
      throw new Error(extractErrorMessage(payload, '导入失败'));
    }
    const d = payload.data || {};
    const added = Number(d.added ?? 0);
    const skipped = Number(d.skipped ?? 0);
    const invalid = Array.isArray(d.invalid) ? d.invalid.length : 0;
    showToast(`导入完成：新增 ${added}，跳过 ${skipped}，无效 ${invalid}`, 'success');
    closeTavilyImportModal();
    if (q('tavily-import-keys')) q('tavily-import-keys').value = '';
    await loadTavilyKeys();
  } catch (e) {
    showToast(`导入失败: ${e?.message || e}`, 'error');
  } finally {
    isSubmitting = false;
    if (btn) btn.textContent = '开始导入';
  }
}

function openTavilyEditModal(row) {
  const modal = q('tavily-edit-modal');
  if (!modal) return;

  q('tavily-edit-key').value = row.key;
  q('tavily-edit-key-display').value = row.key;
  q('tavily-edit-status').textContent = row.status || '-';
  q('tavily-edit-active').checked = Boolean(row.isActive);
  q('tavily-edit-note').value = row.note || '';
  q('tavily-edit-tags').value = (row.tags || []).join(', ');

  modal.classList.remove('hidden');
}

function closeTavilyEditModal() {
  const modal = q('tavily-edit-modal');
  if (modal) modal.classList.add('hidden');
}

async function saveTavilyEdit() {
  if (isSubmitting) return;
  apiKey = await ensureApiKey();
  if (apiKey === null) return;

  const key = String(q('tavily-edit-key')?.value || '').trim();
  const isActive = Boolean(q('tavily-edit-active')?.checked);
  const note = String(q('tavily-edit-note')?.value || '');
  const tagsText = String(q('tavily-edit-tags')?.value || '');
  const tags = tagsText
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);

  if (!key) {
    showToast('Missing key', 'error');
    return;
  }

  const btn = q('btn-tavily-edit-submit');
  if (btn) btn.textContent = '保存中...';
  isSubmitting = true;

  try {
    await updateTavilyKey(key, { is_active: isActive, note, tags });
    closeTavilyEditModal();
    showToast('保存成功', 'success');
  } catch (e) {
    showToast(`保存失败: ${e?.message || e}`, 'error');
  } finally {
    isSubmitting = false;
    if (btn) btn.textContent = '保存';
  }
}

async function updateTavilyKey(key, patch) {
  apiKey = await ensureApiKey();
  if (apiKey === null) return;

  try {
    const res = await fetch('/api/v1/admin/tavily/keys/update', {
      method: 'POST',
      headers: { ...buildAuthHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, ...patch }),
    });
    if (res.status === 401) return logout();
    const payload = await parseJsonSafely(res);
    if (!res.ok || payload?.success !== true) {
      throw new Error(extractErrorMessage(payload, '更新失败'));
    }
    await loadTavilyKeys();
    showToast('更新成功', 'success');
  } catch (e) {
    showToast(`更新失败: ${e?.message || e}`, 'error');
    throw e;
  }
}

async function deleteTavilyKeys(keys) {
  apiKey = await ensureApiKey();
  if (apiKey === null) return;

  try {
    const res = await fetch('/api/v1/admin/tavily/keys/delete', {
      method: 'POST',
      headers: { ...buildAuthHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    });
    if (res.status === 401) return logout();
    const payload = await parseJsonSafely(res);
    if (!res.ok || payload?.success !== true) {
      throw new Error(extractErrorMessage(payload, '删除失败'));
    }
    await loadTavilyKeys();
    showToast('删除成功', 'success');
  } catch (e) {
    showToast(`删除失败: ${e?.message || e}`, 'error');
  }
}

async function startTavilySync() {
  apiKey = await ensureApiKey();
  if (apiKey === null) return;

  const btn = q('btn-tavily-sync');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/v1/admin/tavily/keys/sync', {
      method: 'POST',
      headers: { ...buildAuthHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.status === 401) return logout();
    const payload = await parseJsonSafely(res);
    if (!res.ok) {
      throw new Error(extractErrorMessage(payload, '同步失败'));
    }
    if (payload?.success === false) {
      // When already running, the API returns success:false with message + data
      showToast(String(payload?.message || '同步任务正在进行中'), 'error');
    } else {
      showToast('同步任务已启动', 'success');
    }

    await pollTavilySyncProgressOnce();
    startSyncPolling();
  } catch (e) {
    showToast(`同步失败: ${e?.message || e}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function startSyncPolling() {
  if (syncPollTimer) clearInterval(syncPollTimer);
  syncPollTimer = setInterval(pollTavilySyncProgressOnce, 1200);
}

async function pollTavilySyncProgressOnce() {
  apiKey = await ensureApiKey();
  if (apiKey === null) return;

  try {
    const res = await fetch('/api/v1/admin/tavily/keys/sync-progress', { headers: buildAuthHeaders(apiKey) });
    if (res.status === 401) return logout();
    const payload = await parseJsonSafely(res);
    if (!res.ok || payload?.success !== true) return;
    const progress = payload.data || {};
    updateSyncIndicator(progress);
    if (!progress.running && syncPollTimer) {
      clearInterval(syncPollTimer);
      syncPollTimer = null;
      await loadTavilyKeys();
    }
  } catch (e) {
    // ignore polling errors
  }
}

function bindModalOverlayClose() {
  const importModal = q('tavily-import-modal');
  if (importModal) {
    importModal.addEventListener('click', (event) => {
      if (event.target === importModal) closeTavilyImportModal();
    });
  }
  const editModal = q('tavily-edit-modal');
  if (editModal) {
    editModal.addEventListener('click', (event) => {
      if (event.target === editModal) closeTavilyEditModal();
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (q('tavily-edit-modal') && !q('tavily-edit-modal').classList.contains('hidden')) closeTavilyEditModal();
    if (q('tavily-import-modal') && !q('tavily-import-modal').classList.contains('hidden')) closeTavilyImportModal();
  });
}

async function init() {
  apiKey = await ensureApiKey();
  if (apiKey === null) return;
  bindModalOverlayClose();
  bindTableEvents();
  await loadTavilyKeys();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

