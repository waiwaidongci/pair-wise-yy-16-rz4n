import type {
  CurveTemplate,
  FiringPoint,
  FiringSample,
  KilnSession,
  QuarantineItem,
  ReviewSnapshot,
  SampleBackup,
  SessionConflict,
} from '../types/firing'

export const STORAGE_KEY = 'pair-wise-yy-16-firing-studio'
export const TAB_PREFS_KEY = 'pair-wise-yy-16-firing-studio-tabprefs'
export const SCHEMA_VERSION = 2
export const BACKUPS_PER_SESSION = 3
export const RAW_TEXT_LIMIT = 200_000
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface SharedState {
  schema: 2
  sessions: KilnSession[]
  templates: CurveTemplate[]
  quarantine: QuarantineItem[]
  backups: SampleBackup[]
  conflicts: SessionConflict[]
  tombstones: Array<{ id: string; at: string }>
  lastClient?: string
}

export interface TabPrefs {
  activeSessionId: string
  overlaySessionIds: string[]
}

export interface LoadResult {
  state: SharedState | null
  corrupted?: QuarantineItem
  legacyPrefs?: TabPrefs
}

/* ------------------------------------------------------------------ */
/* 读取与迁移                                                           */
/* ------------------------------------------------------------------ */

export function loadShared(): LoadResult {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return { state: null }
  }
  if (!raw) return { state: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 存储损坏：原文隔离，绝不让坏数据导致整个应用不可用
    const corrupted: QuarantineItem = {
      id: `q-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      kind: 'storage-raw',
      reason: '本地存储 JSON 解析失败，原文已隔离。',
      rawText: raw.slice(0, RAW_TEXT_LIMIT),
    }
    return { state: null, corrupted }
  }

  const { state, quarantine } = sanitizeShared(parsed)
  state.quarantine.push(...quarantine)

  // v1 版本中活动窑次/叠加选择保存在同一对象内，作为首装偏好迁移
  let legacyPrefs: TabPrefs | undefined
  if (isRecord(parsed) && typeof parsed.activeSessionId === 'string') {
    legacyPrefs = {
      activeSessionId: parsed.activeSessionId,
      overlaySessionIds: Array.isArray(parsed.overlaySessionIds)
        ? parsed.overlaySessionIds.filter((id): id is string => typeof id === 'string')
        : [],
    }
  }
  return { state, legacyPrefs }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value)
}

/** 兼容 v1 原始结构（无 schema 字段）以及未来更高版本的尽力读取 */
export function sanitizeShared(parsed: unknown): { state: SharedState; quarantine: QuarantineItem[] } {
  const quarantine: QuarantineItem[] = []
  const root = isRecord(parsed) ? parsed : {}
  const rawSessions = asArray(root.sessions)
  const rawTemplates = asArray(root.templates)

  const sessions: KilnSession[] = []
  rawSessions.forEach((record) => {
    const result = sanitizeSession(record)
    if (result.ok) sessions.push(result.session)
    else quarantine.push(result.item)
  })

  const templates: CurveTemplate[] = []
  rawTemplates.forEach((record) => {
    const result = sanitizeTemplate(record)
    if (result.ok) templates.push(result.template)
    else quarantine.push(result.item)
  })

  const state: SharedState = {
    schema: SCHEMA_VERSION,
    sessions,
    templates,
    quarantine: asArray(root.quarantine).flatMap((item) => (isQuarantine(item) ? [item] : [])),
    backups: asArray(root.backups).flatMap((item) => (isBackup(item) ? [item] : [])),
    conflicts: asArray(root.conflicts).flatMap((item) => (isConflict(item) ? [item] : [])),
    tombstones: asArray(root.tombstones).flatMap((item) =>
      isRecord(item) && typeof item.id === 'string'
        ? [{ id: item.id, at: str(item.at, new Date().toISOString()) }]
        : [],
    ),
    lastClient: typeof root.lastClient === 'string' ? root.lastClient : undefined,
  }
  pruneTombstones(state)
  return { state, quarantine }
}

function sanitizePoints(value: unknown): FiringPoint[] | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const points: FiringPoint[] = []
  for (const row of value) {
    if (!isRecord(row)) return null
    const timeMin = num(row.timeMin, NaN)
    const tempC = num(row.tempC, NaN)
    if (!Number.isFinite(timeMin) || !Number.isFinite(tempC) || timeMin < 0 || tempC < 0 || tempC > 1800) return null
    points.push({ id: str(row.id, `point-${points.length}`), timeMin, tempC })
  }
  return points.sort((a, b) => a.timeMin - b.timeMin || a.tempC - b.tempC)
}

function sanitizeSamples(value: unknown): FiringSample[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row, index) => {
    if (!isRecord(row)) return []
    const timeMin = num(row.timeMin, NaN)
    const tempC = num(row.tempC, NaN)
    if (!Number.isFinite(timeMin) || !Number.isFinite(tempC) || timeMin < 0 || tempC < -50 || tempC > 1800) return []
    return [{ id: str(row.id, `sample-${index}`), timeMin, tempC }]
  })
}

function sanitizeReview(value: unknown, sessionId: string): ReviewSnapshot | null {
  if (!isRecord(value)) return null
  const points = sanitizePoints(value.points)
  if (!points || typeof value.version !== 'number' || typeof value.publishedAt !== 'string') return null
  const deviation = isRecord(value.deviation)
    ? {
        sampleCount: num(value.deviation.sampleCount),
        meanAbs: num(value.deviation.meanAbs),
        maxAbs: num(value.deviation.maxAbs),
        maxAtMin: num(value.deviation.maxAtMin),
        maxTarget: num(value.deviation.maxTarget),
        maxActual: num(value.deviation.maxActual),
      }
    : { sampleCount: 0, meanAbs: 0, maxAbs: 0, maxAtMin: 0, maxTarget: 0, maxActual: 0 }
  const basis = isRecord(value.basis)
    ? {
        points: str(value.basis.points, ''),
        timeOffset: str(value.basis.timeOffset, ''),
        samples: str(value.basis.samples, ''),
        materials: str(value.basis.materials, ''),
      }
    : { points: '', timeOffset: '', samples: '', materials: '' }
  return {
    id: str(value.id, `review-${sessionId}-${value.version}`),
    version: value.version,
    publishedAt: value.publishedAt,
    clientId: str(value.clientId, 'unknown'),
    clientLabel: str(value.clientLabel, '其他标签页'),
    clay: str(value.clay, ''),
    glaze: str(value.glaze, ''),
    points,
    timeOffsetMin: num(value.timeOffsetMin),
    actualSamples: sanitizeSamples(value.actualSamples),
    risks: Array.isArray(value.risks) ? (value.risks as ReviewSnapshot['risks']) : [],
    deviation,
    basis,
    note: typeof value.note === 'string' ? value.note : undefined,
  }
}

export function sanitizeSession(record: unknown): { ok: true; session: KilnSession } | { ok: false; item: QuarantineItem } {
  if (!isRecord(record) || typeof record.id !== 'string') {
    return { ok: false, item: badRecord('session-record', '窑次记录缺少 id 或结构损坏。', record) }
  }
  const points = sanitizePoints(record.points)
  if (!points) {
    return {
      ok: false,
      item: badRecord('session-record', `窑次 ${str(record.name, record.id)} 的目标曲线缺失或关键点损坏。`, record, str(record.id), str(record.name)),
    }
  }
  const reviews = asArray(record.reviews).flatMap((item) => {
    const review = sanitizeReview(item, record.id as string)
    return review ? [review] : []
  })
  const status = ['draft', 'completed', 'review'].includes(str(record.status))
    ? (str(record.status) as KilnSession['status'])
    : 'draft'
  const session: KilnSession = {
    id: record.id,
    name: str(record.name, '未命名窑次'),
    kiln: str(record.kiln, '未知窑炉'),
    clay: str(record.clay, ''),
    glaze: str(record.glaze, ''),
    firedAt: str(record.firedAt, ''),
    status,
    timeOffsetMin: num(record.timeOffsetMin),
    points,
    actualSamples: sanitizeSamples(record.actualSamples),
    revision: Math.max(0, Math.trunc(num(record.revision))),
    updatedAt: str(record.updatedAt, new Date(0).toISOString()),
    updatedById: typeof record.updatedById === 'string' ? record.updatedById : undefined,
    updatedBy: typeof record.updatedBy === 'string' ? record.updatedBy : undefined,
    reviews,
    lastReviewId: typeof record.lastReviewId === 'string' ? record.lastReviewId : undefined,
  }
  return { ok: true, session }
}

export function sanitizeTemplate(record: unknown): { ok: true; template: CurveTemplate } | { ok: false; item: QuarantineItem } {
  if (!isRecord(record) || typeof record.id !== 'string') {
    return { ok: false, item: badRecord('template-record', '曲线模板缺少 id 或结构损坏。', record) }
  }
  const points = sanitizePoints(record.points)
  if (!points) {
    return {
      ok: false,
      item: badRecord('template-record', `模板 ${str(record.name, record.id)} 的曲线关键点损坏。`, record, undefined, str(record.name)),
    }
  }
  return {
    ok: true,
    template: {
      id: record.id,
      name: str(record.name, '未命名模板'),
      clay: str(record.clay, ''),
      glaze: str(record.glaze, ''),
      peakTempC: num(record.peakTempC, Math.max(...points.map((point) => point.tempC))),
      description: str(record.description, ''),
      points: points.map(({ timeMin, tempC }) => ({ timeMin, tempC })),
      updatedAt: str(record.updatedAt, new Date(0).toISOString()),
    },
  }
}

function badRecord(
  kind: QuarantineItem['kind'],
  reason: string,
  record: unknown,
  sessionId?: string,
  sessionName?: string,
): QuarantineItem {
  let rawText: string
  try {
    rawText = JSON.stringify(record, null, 2).slice(0, RAW_TEXT_LIMIT)
  } catch {
    rawText = String(record).slice(0, RAW_TEXT_LIMIT)
  }
  return {
    id: `q-${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    kind,
    reason,
    record,
    rawText,
    sessionId,
    sessionName,
  }
}

function isQuarantine(value: unknown): value is QuarantineItem {
  return isRecord(value) && typeof value.id === 'string' && typeof value.kind === 'string' && typeof value.reason === 'string'
}

function isBackup(value: unknown): value is SampleBackup {
  return isRecord(value) && typeof value.id === 'string' && typeof value.sessionId === 'string' && Array.isArray(value.samples)
}

function isConflict(value: unknown): value is SessionConflict {
  return (
    isRecord(value)
    && typeof value.id === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.loserClientId === 'string'
    && isRecord(value.loserSnapshot)
    && Array.isArray(value.resolvedBy)
  )
}

/* ------------------------------------------------------------------ */
/* 多标签页合并                                                         */
/* ------------------------------------------------------------------ */

function remoteWins(current: KilnSession, incoming: KilnSession): boolean {
  if (incoming.revision !== current.revision) return incoming.revision > current.revision
  return incoming.updatedAt >= current.updatedAt
}

/**
 * 三方合并：本标签页即将写入的状态 + 存储中其他标签页刚写入的状态。
 * 窑次按 revision/updatedAt 最后写入胜出，但复核版本做并集，避免发布记录互相覆盖。
 */
export function mergeShared(local: SharedState, remote: SharedState): SharedState {
  const merged: SharedState = {
    schema: SCHEMA_VERSION,
    sessions: [],
    templates: [],
    quarantine: [],
    backups: [],
    conflicts: [],
    tombstones: [],
    lastClient: remote.lastClient ?? local.lastClient,
  }

  const sessionMap = new Map<string, KilnSession>()
  const absorb = (incoming: KilnSession) => {
    const current = sessionMap.get(incoming.id)
    if (!current) {
      sessionMap.set(incoming.id, clone(incoming))
      return
    }
    const winner = remoteWins(current, incoming) ? incoming : current
    const mergedSession: KilnSession = { ...clone(winner) }
    // 复核版本并集（按 id 去重，保留版本号更大的记录）
    const reviewMap = new Map<string, ReviewSnapshot>()
    for (const review of [...current.reviews, ...incoming.reviews]) {
      const existing = reviewMap.get(review.id)
      if (!existing || review.version >= existing.version) reviewMap.set(review.id, review)
    }
    mergedSession.reviews = [...reviewMap.values()].sort((a, b) => a.version - b.version)
    if (
      mergedSession.reviews.length &&
      (!mergedSession.lastReviewId || !mergedSession.reviews.some((r) => r.id === mergedSession.lastReviewId))
    ) {
      mergedSession.lastReviewId = mergedSession.reviews.at(-1)!.id
    }
    sessionMap.set(incoming.id, mergedSession)
  }
  local.sessions.forEach(absorb)
  remote.sessions.forEach(absorb)

  // 墓碑：删除标记仍在有效期内且晚于窑次更新时间，则移除该窑次
  const tombMap = new Map<string, string>()
  for (const tomb of [...local.tombstones, ...remote.tombstones]) {
    const existing = tombMap.get(tomb.id)
    if (!existing || tomb.at >= existing) tombMap.set(tomb.id, tomb.at)
  }
  merged.tombstones = pruneTombstoneMap(tombMap)
  for (const [id, at] of tombMap) {
    const session = sessionMap.get(id)
    if (session && at >= session.updatedAt) sessionMap.delete(id)
  }
  merged.sessions = [...sessionMap.values()]

  const templateMap = new Map<string, CurveTemplate>()
  for (const template of [...local.templates, ...remote.templates]) {
    const existing = templateMap.get(template.id)
    if (!existing || template.updatedAt >= existing.updatedAt) templateMap.set(template.id, template)
  }
  merged.templates = [...templateMap.values()]

  const qMap = new Map<string, QuarantineItem>()
  for (const item of [...local.quarantine, ...remote.quarantine]) qMap.set(item.id, item)
  merged.quarantine = [...qMap.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const bMap = new Map<string, SampleBackup>()
  for (const backup of [...local.backups, ...remote.backups]) bMap.set(backup.id, backup)
  merged.backups = [...bMap.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const cMap = new Map<string, SessionConflict>()
  for (const conflict of [...local.conflicts, ...remote.conflicts]) {
    const existing = cMap.get(conflict.id)
    if (!existing) {
      cMap.set(conflict.id, conflict)
    } else {
      // 合并已消除标记（同一条冲突可能在两端被分别确认）
      cMap.set(conflict.id, {
        ...existing,
        ...conflict,
        resolvedBy: [...new Set([...existing.resolvedBy, ...conflict.resolvedBy])],
      })
    }
  }
  // 覆盖方与被覆盖方都确认后，冲突记录完成使命，予以回收
  merged.conflicts = [...cMap.values()]
    .filter((conflict) => {
      const bothResolved =
        conflict.resolvedBy.includes(conflict.winnerClientId)
        && conflict.resolvedBy.includes(conflict.loserClientId)
      return !bothResolved
    })
    .sort((a, b) => a.at.localeCompare(b.at))

  return merged
}

function pruneTombstones(state: SharedState) {
  const map = new Map<string, string>()
  for (const tomb of state.tombstones) map.set(tomb.id, tomb.at)
  state.tombstones = pruneTombstoneMap(map)
}

function pruneTombstoneMap(map: Map<string, string>) {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS
  for (const [id, at] of map) {
    if (new Date(at).getTime() < cutoff) map.delete(id)
  }
  return [...map.entries()].map(([id, at]) => ({ id, at }))
}

/* ------------------------------------------------------------------ */
/* 写入（含配额保护）与标签页偏好                                        */
/* ------------------------------------------------------------------ */

export function commitShared(state: SharedState): { ok: boolean; evicted: string[] } {
  const evicted: string[] = []
  let payload = clone(state)
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
      return { ok: true, evicted }
    } catch {
      // 容量不足：依次淘汰隔离原文与最旧的实测备份，绝不丢当前业务数据
      const removed = evictOldest(payload)
      if (!removed) return { ok: false, evicted }
      evicted.push(removed)
    }
  }
  return { ok: false, evicted }
}

function evictOldest(state: SharedState): string | null {
  const withRaw = state.quarantine.find((item) => item.rawText)
  if (withRaw) {
    withRaw.rawText = undefined
    withRaw.reason += '（原文因存储空间不足已移除，记录信息仍保留）'
    return 'quarantine-raw'
  }
  const oldest = [...state.backups].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  if (oldest) {
    state.backups = state.backups.filter((item) => item.id !== oldest.id)
    return 'sample-backup'
  }
  return null
}

export function loadTabPrefs(): TabPrefs | null {
  try {
    const raw = sessionStorage.getItem(TAB_PREFS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed) || typeof parsed.activeSessionId !== 'string') return null
    return {
      activeSessionId: parsed.activeSessionId,
      overlaySessionIds: Array.isArray(parsed.overlaySessionIds)
        ? parsed.overlaySessionIds.filter((id): id is string => typeof id === 'string')
        : [],
    }
  } catch {
    return null
  }
}

export function saveTabPrefs(prefs: TabPrefs) {
  try {
    sessionStorage.setItem(TAB_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // 偏好写失败不影响业务数据
  }
}

/* ------------------------------------------------------------------ */
/* 标签页身份                                                           */
/* ------------------------------------------------------------------ */

const CLIENT_KEY = 'pair-wise-yy-16-client'

export function getClientIdentity(): { clientId: string; clientLabel: string } {
  let clientId = sessionStorage.getItem(CLIENT_KEY)
  if (!clientId) {
    clientId = `tab-${crypto.randomUUID().slice(0, 8)}`
    sessionStorage.setItem(CLIENT_KEY, clientId)
  }
  return { clientId, clientLabel: labelFor(clientId) }
}

function labelFor(clientId: string): string {
  const now = new Date()
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return `标签页 ${clientId.slice(-4)} · ${time}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
