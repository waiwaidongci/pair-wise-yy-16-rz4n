import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { createMockSessions, MOCK_TEMPLATES } from '../data/mockSessions'
import type { BadRow } from '../utils/csv'
import type {
  CurveTemplate,
  FiringPoint,
  FiringReview,
  FiringSample,
  KilnSession,
  QuarantinedRecord,
} from '../types/firing'
import {
  cloneSession,
  createReview,
  latestReview,
  nextReviewVersion,
  reviewStaleItems,
  templateToPoints,
  validateCurve,
  calculateDeviation,
} from '../utils/curve'

const STORAGE_KEY = 'pair-wise-yy-16-firing-studio'
const QUARANTINE_KEY = 'pair-wise-yy-16-firing-studio-quarantine'
const SCHEMA_VERSION = 2

function isPoint(value: unknown): value is FiringPoint {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as FiringPoint).id === 'string' &&
    typeof (value as FiringPoint).timeMin === 'number' &&
    typeof (value as FiringPoint).tempC === 'number'
  )
}

function isSample(value: unknown): value is FiringSample {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as FiringSample).id === 'string' &&
    typeof (value as FiringSample).timeMin === 'number' &&
    typeof (value as FiringSample).tempC === 'number'
  )
}

function normalizeSession(raw: any, quarantined: QuarantinedRecord[]): KilnSession | null {
  const badId = raw?.id ?? 'unknown'
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof raw.id !== 'string' ||
    typeof raw.name !== 'string' ||
    !Array.isArray(raw.points)
  ) {
    quarantined.push({
      id: `bad-session-${badId}`,
      kind: 'session',
      reason: '缺少必要字段（id / name）或 points 不是数组',
      foundAt: new Date().toISOString(),
      raw,
    })
    return null
  }
  const points = raw.points.filter(isPoint)
  if (points.length < 2) {
    quarantined.push({
      id: `bad-session-${badId}`,
      kind: 'session',
      reason: '有效关键点少于 2 个，无法恢复曲线',
      foundAt: new Date().toISOString(),
      raw,
    })
    return null
  }

  let actualSamples: FiringSample[] = []
  if (Array.isArray(raw.actualSamples)) {
    const valid = raw.actualSamples.filter(isSample)
    if (valid.length !== raw.actualSamples.length) {
      quarantined.push({
        id: `bad-session-samples-${badId}`,
        kind: 'session',
        reason: `${raw.actualSamples.length - valid.length} 条实测采样记录无法识别，已隔离并保留其余 ${valid.length} 点`,
        foundAt: new Date().toISOString(),
        raw: { sessionId: raw.id, bad: raw.actualSamples.filter((sample: unknown) => !isSample(sample)) },
      })
    }
    actualSamples = valid
  } else if (raw.actualSamples !== undefined) {
    quarantined.push({
      id: `bad-session-samples-${badId}`,
      kind: 'session',
      reason: 'actualSamples 字段不是数组，实测数据已重置为空',
      foundAt: new Date().toISOString(),
      raw: { sessionId: raw.id, actualSamples: raw.actualSamples },
    })
  }

  const reviews = Array.isArray(raw.reviews)
    ? raw.reviews.filter(
        (review: unknown) =>
          !!review &&
          typeof review === 'object' &&
          typeof (review as FiringReview).id === 'string' &&
          typeof (review as FiringReview).version === 'number',
      )
    : []

  return {
    id: raw.id,
    name: raw.name,
    kiln: typeof raw.kiln === 'string' ? raw.kiln : '',
    clay: typeof raw.clay === 'string' ? raw.clay : '青瓷泥',
    glaze: typeof raw.glaze === 'string' ? raw.glaze : '天青釉',
    firedAt: typeof raw.firedAt === 'string' ? raw.firedAt : '',
    status: ['draft', 'review', 'completed'].includes(raw.status) ? raw.status : 'draft',
    timeOffsetMin: typeof raw.timeOffsetMin === 'number' ? raw.timeOffsetMin : 0,
    points,
    actualSamples,
    reviews,
    sampleBackup:
      raw.sampleBackup && Array.isArray(raw.sampleBackup.samples) ? raw.sampleBackup : null,
  }
}

function normalizeTemplate(raw: any, quarantined: QuarantinedRecord[]): CurveTemplate | null {
  const badId = raw?.id ?? 'unknown'
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof raw.id !== 'string' ||
    typeof raw.name !== 'string' ||
    !Array.isArray(raw.points)
  ) {
    quarantined.push({
      id: `bad-template-${badId}`,
      kind: 'template',
      reason: '缺少必要字段（id / name）或 points 不是数组',
      foundAt: new Date().toISOString(),
      raw,
    })
    return null
  }
  const points = raw.points
    .filter(
      (point: any) =>
        point && typeof point.timeMin === 'number' && typeof point.tempC === 'number',
    )
    .map((point: any) => ({ timeMin: point.timeMin, tempC: point.tempC }))
  if (points.length < 2) {
    quarantined.push({
      id: `bad-template-${badId}`,
      kind: 'template',
      reason: '有效关键点少于 2 个，无法恢复曲线',
      foundAt: new Date().toISOString(),
      raw,
    })
    return null
  }
  const peakTemp = points.length
    ? Math.max(...points.map((point: { timeMin: number; tempC: number }) => point.tempC))
    : 1200
  return {
    id: raw.id,
    name: raw.name,
    clay: typeof raw.clay === 'string' ? raw.clay : '',
    glaze: typeof raw.glaze === 'string' ? raw.glaze : '',
    peakTempC:
      typeof raw.peakTempC === 'number'
        ? raw.peakTempC
        : peakTemp,
    description: typeof raw.description === 'string' ? raw.description : '',
    points,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  }
}

function withMigratedReviews(sessions: KilnSession[]): KilnSession[] {
  return sessions.map((session) => {
    if (!Array.isArray(session.reviews)) session.reviews = []
    if (!session.reviews.length && session.actualSamples.length) {
      session.reviews = [createReview(session, 1, '升级前数据补录', 'migration')]
    }
    if (!session.sampleBackup) session.sampleBackup = null
    return session
  })
}

function loadState(): {
  sessions: KilnSession[]
  templates: CurveTemplate[]
  activeSessionId: string
  overlaySessionIds: string[]
  quarantined: QuarantinedRecord[]
} | null {
  const quarantined: QuarantinedRecord[] = []
  let raw: any
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    if (!text) return null
    raw = JSON.parse(text)
  } catch {
    const fallbackSessions = withMigratedReviews(createMockSessions())
    return {
      sessions: fallbackSessions,
      templates: MOCK_TEMPLATES,
      activeSessionId: fallbackSessions[0].id,
      overlaySessionIds: [],
      quarantined: [
        {
          id: 'bad-blob-unparseable',
          kind: 'session',
          reason: '本地数据整体解析失败，已重置为示例窑次；损坏内容已隔离',
          foundAt: new Date().toISOString(),
          raw: null,
        },
      ],
    }
  }
  if (!raw || typeof raw !== 'object') return null

  const rawSessions: unknown[] = Array.isArray(raw.sessions) ? raw.sessions : []
  const rawTemplates: unknown[] = Array.isArray(raw.templates) ? raw.templates : []
  const sessions = rawSessions
    .map((session: unknown) => normalizeSession(session, quarantined))
    .filter((session): session is KilnSession => session !== null)
  const templates = rawTemplates
    .map((template: unknown) => normalizeTemplate(template, quarantined))
    .filter((template): template is CurveTemplate => template !== null)

  const finalSessions = withMigratedReviews(sessions.length ? sessions : createMockSessions())
  const finalTemplates = templates.length ? templates : MOCK_TEMPLATES

  const activeSessionId =
    typeof raw.activeSessionId === 'string' &&
    finalSessions.some((session) => session.id === raw.activeSessionId)
      ? raw.activeSessionId
      : finalSessions[0].id
  const overlaySessionIds = Array.isArray(raw.overlaySessionIds)
    ? raw.overlaySessionIds.filter(
        (id: unknown) => typeof id === 'string' && finalSessions.some((session) => session.id === id),
      )
    : finalSessions.slice(1, 3).map((session) => session.id)

  return {
    sessions: finalSessions,
    templates: finalTemplates,
    activeSessionId,
    overlaySessionIds,
    quarantined,
  }
}

function loadQuarantine(): QuarantinedRecord[] {
  try {
    const text = localStorage.getItem(QUARANTINE_KEY)
    return text ? (JSON.parse(text) as QuarantinedRecord[]) : []
  } catch {
    return []
  }
}

function persistQuarantine(records: QuarantinedRecord[]) {
  try {
    localStorage.setItem(QUARANTINE_KEY, JSON.stringify(records))
  } catch {
    /* 隔离区写入失败不影响主流程 */
  }
}

function mergeQuarantine(
  current: QuarantinedRecord[],
  incoming: QuarantinedRecord[],
): QuarantinedRecord[] {
  const seen = new Set<string>()
  const merged: QuarantinedRecord[] = []
  for (const record of [...incoming, ...current]) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    merged.push(record)
  }
  return merged
}

export const useFiringStore = defineStore('firing-studio', () => {
  const persisted = loadState()
  const sessions = ref<KilnSession[]>(
    withMigratedReviews(persisted?.sessions?.length ? persisted.sessions : createMockSessions()),
  )
  const templates = ref<CurveTemplate[]>(
    persisted?.templates?.length ? persisted.templates : MOCK_TEMPLATES,
  )
  const activeSessionId = ref(
    persisted?.activeSessionId && sessions.value.some((item) => item.id === persisted.activeSessionId)
      ? persisted.activeSessionId
      : sessions.value[0].id,
  )
  const overlaySessionIds = ref<string[]>(
    persisted?.overlaySessionIds?.filter((id) => sessions.value.some((item) => item.id === id))
      ?? sessions.value.slice(1, 3).map((item) => item.id),
  )
  const quarantined = ref<QuarantinedRecord[]>(
    mergeQuarantine(loadQuarantine(), persisted?.quarantined ?? []),
  )
  persistQuarantine(quarantined.value)

  const selectedPointId = ref<string | null>(sessions.value[0].points[0]?.id ?? null)
  const selectedStageIndex = ref<number | null>(0)
  const undoStack = ref<Array<{ sessions: KilnSession[]; activeSessionId: string }>>([])
  const redoStack = ref<Array<{ sessions: KilnSession[]; activeSessionId: string }>>([])
  const dragHistoryPending = ref(false)

  const activeReviewId = ref<string | null>(null)
  const lastImportBadRows = ref<BadRow[]>([])
  const externalUpdate = ref(false)

  const activeSession = computed(
    () => sessions.value.find((session) => session.id === activeSessionId.value) ?? sessions.value[0],
  )
  const validationIssues = computed(() => validateCurve(activeSession.value))
  const visibleSessions = computed(() => {
    const ids = new Set([activeSessionId.value, ...overlaySessionIds.value])
    return sessions.value.filter((session) => ids.has(session.id))
  })
  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)

  const activeReview = computed<FiringReview | null>(() => {
    const session = activeSession.value
    if (!session) return null
    if (activeReviewId.value) {
      const found = session.reviews?.find((review) => review.id === activeReviewId.value)
      if (found) return found
    }
    return latestReview(session)
  })
  const latestReviewOfActive = computed(() => latestReview(activeSession.value))
  const viewingLatest = computed(
    () => !latestReviewOfActive.value || activeReview.value?.id === latestReviewOfActive.value.id,
  )
  const activeReviewStale = computed(() =>
    activeReview.value ? reviewStaleItems(activeSession.value, activeReview.value) : [],
  )
  const displayedIssues = computed(() =>
    viewingLatest.value ? validateCurve(activeSession.value) : activeReview.value?.riskIssues ?? [],
  )
  const displayedDeviation = computed(() =>
    viewingLatest.value
      ? calculateDeviation(
          activeSession.value.points,
          activeSession.value.actualSamples,
          activeSession.value.timeOffsetMin,
        )
      : activeReview.value?.deviation ??
        calculateDeviation(
          activeSession.value.points,
          activeSession.value.actualSamples,
          activeSession.value.timeOffsetMin,
        ),
  )

  watch(activeSessionId, () => {
    activeReviewId.value = null
  })

  function persist() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        sessions: sessions.value,
        templates: templates.value,
        activeSessionId: activeSessionId.value,
        overlaySessionIds: overlaySessionIds.value,
      }),
    )
  }

  function snapshot() {
    return {
      sessions: sessions.value.map(cloneSession),
      activeSessionId: activeSessionId.value,
    }
  }

  function recordHistory() {
    undoStack.value.push(snapshot())
    if (undoStack.value.length > 40) undoStack.value.shift()
    redoStack.value = []
  }

  function restore(snapshotState: { sessions: KilnSession[]; activeSessionId: string }) {
    sessions.value = snapshotState.sessions.map(cloneSession)
    activeSessionId.value = snapshotState.activeSessionId
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    selectedStageIndex.value = 0
    activeReviewId.value = null
    persist()
  }

  function undo() {
    const previous = undoStack.value.pop()
    if (!previous) return
    redoStack.value.push(snapshot())
    restore(previous)
  }

  function redo() {
    const next = redoStack.value.pop()
    if (!next) return
    undoStack.value.push(snapshot())
    restore(next)
  }

  function beginDrag() {
    if (!dragHistoryPending.value) {
      recordHistory()
      dragHistoryPending.value = true
    }
  }

  function endDrag() {
    dragHistoryPending.value = false
    persist()
  }

  function setActiveSession(id: string) {
    if (!sessions.value.some((session) => session.id === id)) return
    activeSessionId.value = id
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    selectedStageIndex.value = 0
    persist()
  }

  function updatePoint(pointId: string, timeMin: number, tempC: number, record = true) {
    if (record) recordHistory()
    const session = activeSession.value
    const sorted = [...session.points].sort((a, b) => a.timeMin - b.timeMin)
    const index = sorted.findIndex((point) => point.id === pointId)
    const previous = sorted[index - 1]
    const next = sorted[index + 1]
    const minTime = previous ? previous.timeMin + 1 : 0
    const maxTime = next ? next.timeMin - 1 : 1440
    session.points = session.points.map((point) =>
      point.id === pointId
        ? {
            ...point,
            timeMin: Math.round(Math.min(maxTime, Math.max(minTime, timeMin))),
            tempC: Math.round(Math.min(1450, Math.max(0, tempC))),
          }
        : point,
    )
    sessions.value = [...sessions.value]
    persist()
  }

  function addPointAfterStage(stageIndex: number) {
    recordHistory()
    const stages = [...activeSession.value.points].sort((a, b) => a.timeMin - b.timeMin)
    const start = stages[stageIndex]
    const end = stages[stageIndex + 1]
    if (!start || !end) return
    const middleTime = Math.round((start.timeMin + end.timeMin) / 2)
    const middleTemp = Math.round((start.tempC + end.tempC) / 2)
    const point = {
      id: `point-${crypto.randomUUID()}`,
      timeMin: middleTime,
      tempC: middleTemp,
    }
    activeSession.value.points = [...activeSession.value.points, point]
    selectedPointId.value = point.id
    selectedStageIndex.value = stageIndex + 1
    persist()
  }

  function removePoint(pointId: string) {
    if (activeSession.value.points.length <= 3) return
    recordHistory()
    activeSession.value.points = activeSession.value.points.filter((point) => point.id !== pointId)
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    selectedStageIndex.value = 0
    persist()
  }

  function applyTemplate(templateId: string) {
    const template = templates.value.find((item) => item.id === templateId)
    if (!template) return
    recordHistory()
    activeSession.value.points = templateToPoints(template, activeSession.value.id)
    activeSession.value.clay = template.clay
    activeSession.value.glaze = template.glaze
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    selectedStageIndex.value = 0
    persist()
  }

  function saveTemplateFromSession(name: string) {
    const template: CurveTemplate = {
      id: crypto.randomUUID(),
      name: name.trim() || `${activeSession.value.name} 模板`,
      clay: activeSession.value.clay,
      glaze: activeSession.value.glaze,
      peakTempC: Math.max(...activeSession.value.points.map((point) => point.tempC)),
      description: `从 ${activeSession.value.name} 保存，包含 ${activeSession.value.points.length} 个关键点。`,
      points: activeSession.value.points.map(({ timeMin, tempC }) => ({ timeMin, tempC })),
      updatedAt: new Date().toISOString(),
    }
    templates.value.unshift(template)
    persist()
  }

  function importSamples(samples: FiringSample[], badRows: BadRow[] = []) {
    recordHistory()
    const session = activeSession.value
    session.sampleBackup = {
      samples: session.actualSamples.map((sample) => ({ ...sample })),
      savedAt: new Date().toISOString(),
    }
    session.actualSamples = samples
    session.status = 'review'
    lastImportBadRows.value = badRows
    persist()
  }

  function restoreSampleBackup() {
    const backup = activeSession.value.sampleBackup
    if (!backup?.samples.length) return
    recordHistory()
    activeSession.value.actualSamples = backup.samples.map((sample) => ({ ...sample }))
    activeSession.value.sampleBackup = null
    lastImportBadRows.value = []
    persist()
  }

  function clearActualSamples() {
    recordHistory()
    const session = activeSession.value
    session.sampleBackup = {
      samples: session.actualSamples.map((sample) => ({ ...sample })),
      savedAt: new Date().toISOString(),
    }
    session.actualSamples = []
    lastImportBadRows.value = []
    persist()
  }

  function setTimeOffset(offsetMin: number) {
    activeSession.value.timeOffsetMin = Number(offsetMin.toFixed(1))
    persist()
  }

  function updateSessionMeta(patch: Partial<Pick<KilnSession, 'name' | 'kiln' | 'clay' | 'glaze' | 'firedAt' | 'status'>>) {
    recordHistory()
    Object.assign(activeSession.value, patch)
    persist()
  }

  function addSession() {
    recordHistory()
    const source = activeSession.value
    const session: KilnSession = {
      ...cloneSession(source),
      id: crypto.randomUUID(),
      name: `新窑次 ${sessions.value.length + 1}`,
      firedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      status: 'draft',
      actualSamples: [],
      reviews: [],
      sampleBackup: null,
      points: source.points.map((point, index) => ({
        ...point,
        id: `point-new-${Date.now()}-${index}`,
      })),
    }
    sessions.value.unshift(session)
    activeSessionId.value = session.id
    selectedPointId.value = session.points[0]?.id ?? null
    persist()
  }

  function removeSession(id: string) {
    if (sessions.value.length <= 1) return
    recordHistory()
    sessions.value = sessions.value.filter((session) => session.id !== id)
    overlaySessionIds.value = overlaySessionIds.value.filter((sessionId) => sessionId !== id)
    if (activeSessionId.value === id) activeSessionId.value = sessions.value[0].id
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    persist()
  }

  function toggleOverlay(id: string) {
    if (id === activeSessionId.value) return
    overlaySessionIds.value = overlaySessionIds.value.includes(id)
      ? overlaySessionIds.value.filter((sessionId) => sessionId !== id)
      : [...overlaySessionIds.value, id]
    persist()
  }

  function setActiveReview(id: string | null) {
    activeReviewId.value = id
  }

  function publishReview(note = '') {
    const session = activeSession.value
    const fresh = loadState()
    const persistedSession = fresh?.sessions.find((item) => item.id === session.id)
    const version = nextReviewVersion(persistedSession ?? session)
    const review = createReview(session, version, note)
    if (persistedSession) {
      // 合并其他标签页已发布的版本，避免后保存覆盖先保存的复核
      const byId = new Map<string, FiringReview>()
      for (const item of persistedSession.reviews ?? []) byId.set(item.id, item)
      byId.set(review.id, review)
      session.reviews = [...byId.values()].sort((a, b) => a.version - b.version)
    } else {
      session.reviews = [...(session.reviews ?? []), review]
    }
    session.status = 'completed'
    activeReviewId.value = review.id
    persist()
  }

  function clearQuarantine() {
    quarantined.value = []
    persistQuarantine([])
  }

  function reloadFromStorage() {
    const reloaded = loadState()
    if (!reloaded) return
    sessions.value = withMigratedReviews(reloaded.sessions)
    templates.value = reloaded.templates
    quarantined.value = mergeQuarantine(quarantined.value, reloaded.quarantined)
    persistQuarantine(quarantined.value)
    if (!sessions.value.some((session) => session.id === activeSessionId.value)) {
      activeSessionId.value = sessions.value[0]?.id ?? ''
    }
    overlaySessionIds.value = reloaded.overlaySessionIds
    undoStack.value = []
    redoStack.value = []
    selectedPointId.value = activeSession.value?.points[0]?.id ?? null
    selectedStageIndex.value = 0
    activeReviewId.value = null
    externalUpdate.value = false
  }

  function handleStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY && event.newValue !== event.oldValue) {
      externalUpdate.value = true
    }
  }

  onMounted(() => window.addEventListener('storage', handleStorage))
  onUnmounted(() => window.removeEventListener('storage', handleStorage))

  function exportSessionJson() {
    const payload = {
      schema: 'kiln-firing-curve/v1',
      exportedAt: new Date().toISOString(),
      session: activeSession.value,
      validation: validationIssues.value,
      activeReview: activeReview.value,
      reviewStatus: {
        viewingLatest: viewingLatest.value,
        staleItems: activeReviewStale.value,
      },
      timeAlignment: {
        offsetMin: activeSession.value.timeOffsetMin,
        basis: 'actual elapsed time + offset vs target arrival time',
      },
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${activeSession.value.name}-烧成数据.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return {
    sessions,
    templates,
    activeSessionId,
    activeSession,
    selectedPointId,
    selectedStageIndex,
    overlaySessionIds,
    visibleSessions,
    validationIssues,
    canUndo,
    canRedo,
    undo,
    redo,
    beginDrag,
    endDrag,
    setActiveSession,
    updatePoint,
    addPointAfterStage,
    removePoint,
    applyTemplate,
    saveTemplateFromSession,
    importSamples,
    restoreSampleBackup,
    clearActualSamples,
    setTimeOffset,
    updateSessionMeta,
    addSession,
    removeSession,
    toggleOverlay,
    activeReview,
    viewingLatest,
    activeReviewStale,
    displayedIssues,
    displayedDeviation,
    lastImportBadRows,
    externalUpdate,
    quarantined,
    setActiveReview,
    publishReview,
    clearQuarantine,
    reloadFromStorage,
    exportSessionJson,
  }
})
