export type ThemeRematchStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed';

export type ThemeRematchProgress = {
  status: ThemeRematchStatus;
  scanned: number;
  total: number;
  matched: number;
  percent: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  tag_id: number | null;
  user_id: number;
};

const progressByKey = new Map<string, ThemeRematchProgress>();

function keyOf(userId: number, tagId?: number | null): string {
  return `${userId}:${tagId != null && tagId > 0 ? tagId : 'all'}`;
}

function clampPercent(scanned: number, total: number): number {
  if (!total || total <= 0) return scanned > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((scanned / total) * 100)));
}

export function getThemeRematchProgress(
  userId: number,
  tagId?: number | null,
): ThemeRematchProgress | null {
  return progressByKey.get(keyOf(userId, tagId)) || null;
}

export function markThemeRematchQueued(
  userId: number,
  tagId?: number | null,
): ThemeRematchProgress {
  const now = Date.now();
  const prev = progressByKey.get(keyOf(userId, tagId));
  const next: ThemeRematchProgress = {
    status: 'queued',
    scanned: 0,
    total: prev?.total || 0,
    matched: 0,
    percent: 0,
    updated_at: now,
    started_at: null,
    finished_at: null,
    error: null,
    tag_id: tagId != null && tagId > 0 ? tagId : null,
    user_id: userId,
  };
  progressByKey.set(keyOf(userId, tagId), next);
  return next;
}

export function markThemeRematchRunning(
  userId: number,
  input: { tagId?: number | null; total: number },
): ThemeRematchProgress {
  const now = Date.now();
  const next: ThemeRematchProgress = {
    status: 'running',
    scanned: 0,
    total: Math.max(0, Math.floor(input.total || 0)),
    matched: 0,
    percent: 0,
    updated_at: now,
    started_at: now,
    finished_at: null,
    error: null,
    tag_id: input.tagId != null && input.tagId > 0 ? input.tagId : null,
    user_id: userId,
  };
  progressByKey.set(keyOf(userId, input.tagId), next);
  return next;
}

export function updateThemeRematchProgress(
  userId: number,
  input: { tagId?: number | null; scanned: number; total: number; matched: number },
): ThemeRematchProgress {
  const key = keyOf(userId, input.tagId);
  const prev = progressByKey.get(key);
  const now = Date.now();
  const total = Math.max(0, Math.floor(input.total || prev?.total || 0));
  const scanned = Math.max(0, Math.floor(input.scanned || 0));
  const next: ThemeRematchProgress = {
    status: 'running',
    scanned,
    total,
    matched: Math.max(0, Math.floor(input.matched || 0)),
    percent: clampPercent(scanned, total),
    updated_at: now,
    started_at: prev?.started_at || now,
    finished_at: null,
    error: null,
    tag_id: input.tagId != null && input.tagId > 0 ? input.tagId : null,
    user_id: userId,
  };
  progressByKey.set(key, next);
  return next;
}

export function markThemeRematchDone(
  userId: number,
  input: { tagId?: number | null; scanned: number; total: number; matched: number },
): ThemeRematchProgress {
  const key = keyOf(userId, input.tagId);
  const prev = progressByKey.get(key);
  const now = Date.now();
  const total = Math.max(0, Math.floor(input.total || prev?.total || input.scanned || 0));
  const scanned = Math.max(0, Math.floor(input.scanned || 0));
  const next: ThemeRematchProgress = {
    status: 'done',
    scanned,
    total,
    matched: Math.max(0, Math.floor(input.matched || 0)),
    percent: 100,
    updated_at: now,
    started_at: prev?.started_at || now,
    finished_at: now,
    error: null,
    tag_id: input.tagId != null && input.tagId > 0 ? input.tagId : null,
    user_id: userId,
  };
  progressByKey.set(key, next);
  return next;
}

export function markThemeRematchFailed(
  userId: number,
  input: { tagId?: number | null; error: string },
): ThemeRematchProgress {
  const key = keyOf(userId, input.tagId);
  const prev = progressByKey.get(key);
  const now = Date.now();
  const next: ThemeRematchProgress = {
    status: 'failed',
    scanned: prev?.scanned || 0,
    total: prev?.total || 0,
    matched: prev?.matched || 0,
    percent: prev?.percent || 0,
    updated_at: now,
    started_at: prev?.started_at || null,
    finished_at: now,
    error: String(input.error || '关联失败').slice(0, 300),
    tag_id: input.tagId != null && input.tagId > 0 ? input.tagId : null,
    user_id: userId,
  };
  progressByKey.set(key, next);
  return next;
}
