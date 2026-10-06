import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createMockSessions, MOCK_TEMPLATES } from '../data/mockSessions'
import type {
  ConflictFieldInfo,
  ConflictNotice,
  CurveTemplate,
  FiringSample,
  KilnSession,
  QuarantineItem,
  ReviewSnapshot,
  SessionConflict,
} from '../types/firing'
import { cloneSession, templateToPoints, validateCurve } from '../utils/curve'
import {
  BACKUPS_PER_SESSION,
  commitShared,
  getClientIdentity,
  loadShared,
  loadTabPrefs,
  mergeShared,
  saveTabPrefs,
  type SharedState,
} from '../utils/persistence'
import { createReviewSnapshot, reviewState } from '../utils/review'

const STASH_KEY = 'pair-wise-yy-16-firing-stash'

function nowIso() {
  return new Date().toISOString()
}

function summarize(session: KilnSession, field: ConflictFieldInfo['field']): string {
  switch (field) {
    case 'name':
    case 'kiln':
    case 'clay':
    case 'glaze':
    case 'firedAt':
      return String(session[field] || '—')
    case 'timeOffsetMin':
      return `${session.timeOffsetMin} min`
    case 'points': {
      const peak = Math.max(...session.points.map((point) => point.tempC))
      const end = Math.max(...session.points.map((point) => point.timeMin))
      return `${session.points.length} 点 / 峰值 ${peak}℃ / 末点 ${end}min`
    }
    case 'actualSamples':
      return session.actualSamples.length ? `${session.actualSamples.length} 个采样点` : '无实测数据'
  }
}

const CONFLICT_FIELD_LABELS: Record<ConflictFieldInfo['field'], string> = {
  name: '窑次名称',
  kiln: '窑炉',
  clay: '泥料',
  glaze: '釉料',
  firedAt: '烧成时间',
  points: '目标曲线',
  timeOffsetMin: '时间偏移',
  actualSamples: '实测采样',
}

const CONFLICT_FIELDS = Object.keys(CONFLICT_FIELD_LABELS) as ConflictFieldInfo['field'][]

function diffSessions(local: KilnSession, remote: KilnSession): ConflictFieldInfo[] {
  return CONFLICT_FIELDS.flatMap((field) => {
    const localValue = summarize(local, field)
    const remoteValue = summarize(remote, field)
    return localValue === remoteValue
      ? []
      : [{ field, label: CONFLICT_FIELD_LABELS[field], localValue, remoteValue }]
  })
}

function loadStash(): ConflictNotice[] {
  try {
    const raw = sessionStorage.getItem(STASH_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? (parsed as ConflictNotice[]) : []
  } catch {
    return []
  }
}

function saveStash(notices: ConflictNotice[]) {
  try {
    if (notices.length) sessionStorage.setItem(STASH_KEY, JSON.stringify(notices))
    else sessionStorage.removeItem(STASH_KEY)
  } catch {
    // 忽略配额问题
  }
}

export const useFiringStore = defineStore('firing-studio', () => {
  const { clientId, clientLabel } = getClientIdentity()
  const loaded = loadShared()
  const initialState: SharedState = loaded.state ?? {
    schema: 2,
    sessions: createMockSessions(),
    templates: MOCK_TEMPLATES,
    quarantine: loaded.corrupted ? [loaded.corrupted] : [],
    backups: [],
    conflicts: [],
    tombstones: [],
  }

  const sessions = ref<KilnSession[]>(initialState.sessions.map(cloneSession))
  const templates = ref<CurveTemplate[]>(initialState.templates.map((template) => ({ ...template, points: [...template.points] })))
  const quarantine = ref<QuarantineItem[]>(initialState.quarantine.map((item) => ({ ...item })))
  const backups = ref(initialState.backups.map((item) => ({ ...item, samples: [...item.samples] })))
  const conflicts = ref<SessionConflict[]>(
    initialState.conflicts
      .filter((item) => !item.resolvedBy.includes(clientId))
      .map((item) => ({ ...item, resolvedBy: [...item.resolvedBy] })),
  )
  /** 本标签页每个窑次最后一次与磁盘同步时的 revision，用于提交时的并发覆盖检测 */
  const sessionBaseRevisions = new Map<string, number>(
    initialState.sessions.map((session) => [session.id, session.revision]),
  )
  /** 本标签页当前事务中已改动、尚未提交的窑次 */
  let dirtyIds = new Set<string>()

  const tabPrefs = loadTabPrefs() ?? loaded.legacyPrefs
  const activeSessionId = ref(
    tabPrefs?.activeSessionId && sessions.value.some((item) => item.id === tabPrefs.activeSessionId)
      ? tabPrefs.activeSessionId
      : sessions.value[0].id,
  )
  const overlaySessionIds = ref<string[]>(
    tabPrefs?.overlaySessionIds?.filter((id) => sessions.value.some((item) => item.id === id))
      ?? sessions.value.slice(1, 3).map((item) => item.id),
  )
  const selectedPointId = ref<string | null>(sessions.value[0].points[0]?.id ?? null)
  const selectedStageIndex = ref<number | null>(0)
  const undoStack = ref<Array<{ sessions: KilnSession[]; activeSessionId: string }>>([])
  const redoStack = ref<Array<{ sessions: KilnSession[]; activeSessionId: string }>>([])
  const dragHistoryPending = ref(false)
  // 启动时：未提交的本地 stash（无 conflictId）+ 精确属于本标签页的持久化冲突
  const conflictNotices = ref<ConflictNotice[]>(buildInitialNotices())
  /** 当前展示的冲突（取最新一条，其余未处理项仍在队列中） */
  const conflictNotice = computed(() => conflictNotices.value[0] ?? null)
  /** 本标签页已知的磁盘最新状态，用于识别其他标签页写入 */
  let knownRemote = cloneShared(initialState)
  /**
   * 本标签页的 revision 高水位：多个标签页冷启动时同一窑次 revision 相同，
   * 各自简单 +1 会撞号导致最后写入检测失效。每次修改都从 max(当前, 水位)+1 起跳，
   * 保证本标签页给出的 revision 严格大于磁盘上见过的任何值。
   */
  let revisionWatermark = Math.max(0, ...initialState.sessions.map((session) => session.revision))

  const activeSession = computed(
    () => sessions.value.find((session) => session.id === activeSessionId.value) ?? sessions.value[0],
  )
  const validationIssues = computed(() => validateCurve(activeSession.value))
  const activeReview = computed(() => reviewState(activeSession.value))
  const visibleSessions = computed(() => {
    const ids = new Set([activeSessionId.value, ...overlaySessionIds.value])
    return sessions.value.filter((session) => ids.has(session.id))
  })
  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)
  const quarantineCount = computed(() => quarantine.value.length)
  const activeBackups = computed(() =>
    backups.value
      .filter((item) => item.sessionId === activeSession.value.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  )

  function cloneShared(state: SharedState): SharedState {
    return JSON.parse(JSON.stringify(state)) as SharedState
  }

  function toShared(): SharedState {
    return {
      schema: 2,
      sessions: sessions.value.map(cloneSession),
      templates: templates.value.map((template) => ({ ...template, points: [...template.points] })),
      quarantine: quarantine.value.map((item) => ({ ...item })),
      backups: backups.value.map((item) => ({ ...item, samples: item.samples.map((sample) => ({ ...sample })) })),
      conflicts: conflicts.value.map((item) => ({
        ...item,
        fields: item.fields.map((field) => ({ ...field })),
        loserSnapshot: cloneSession(item.loserSnapshot),
        resolvedBy: [...item.resolvedBy],
      })),
      tombstones: knownRemote.tombstones,
      lastClient: clientId,
    }
  }

  function conflictToNotice(conflict: SessionConflict): ConflictNotice {
    return {
      conflictId: conflict.id,
      sessionId: conflict.sessionId,
      sessionName: conflict.sessionName,
      clientLabel: conflict.winnerClientLabel,
      fields: conflict.fields,
      reason: conflict.reason,
      stash: cloneSession(conflict.loserSnapshot),
      at: conflict.at,
    }
  }

  /** 启动时构建冲突队列：保留本页未提交 stash，并仅恢复精确属于本标签页的持久化冲突 */
  function buildInitialNotices(): ConflictNotice[] {
    const stashed = loadStash().filter((notice) => !notice.conflictId)
    const persisted = initialState.conflicts
      .filter((conflict) => conflict.loserClientId === clientId && !conflict.resolvedBy.includes(clientId))
      .map(conflictToNotice)
    return [...persisted, ...stashed]
  }

  /**
   * 提交前并发覆盖检测：本标签页基于 sessionBaseRevisions 编辑，
   * 若磁盘上该窑次 revision 已被其他标签页抬高，说明对方先保存且即将被本次提交盖掉。
   * 把对方完整快照写入持久化冲突队列（随存储带走，对方任何时候打开都能看到并恢复），
   * 本标签页也保留一条提示。然后才允许本地内容以更高 revision 胜出合并。
   */
  function detectCommittedConflicts(local: SharedState, disk: SharedState) {
    for (const id of dirtyIds) {
      const localSession = local.sessions.find((item) => item.id === id)
      const diskSession = disk.sessions.find((item) => item.id === id)
      const baseRevision = sessionBaseRevisions.get(id)
      if (baseRevision === undefined) continue

      // 对方删除而本页保存：revision 高于墓碑时间，合并层会让窑次自然复活（不丢数据），
      // 删除方标签页在 storage 事件中按“本页已删除但远端又更新”走 stash 提示
      if (!diskSession) continue

      if (diskSession.revision > baseRevision) {
        const fields = diffSessions(localSession!, diskSession)
        if (!fields.length) continue
        const conflict: SessionConflict = {
          id: `conflict-${crypto.randomUUID()}`,
          sessionId: id,
          sessionName: diskSession.name,
          winnerClientId: clientId,
          winnerClientLabel: clientLabel,
          // 精确记录被覆盖方：旧数据可能没有 updatedById，退回通用 'other'（不弹专属提示）
          loserClientId: diskSession.updatedById || 'other',
          loserClientLabel: diskSession.updatedBy || '其他标签页',
          loserSnapshot: cloneSession(diskSession),
          fields,
          reason: 'updated',
          at: nowIso(),
          // 本标签页（覆盖方）已知情并继续；被覆盖方需要提示
          resolvedBy: [clientId],
        }
        conflicts.value = [conflict, ...conflicts.value]
        // 本标签页是覆盖方，不弹自我提示；被覆盖方下次同步时会从冲突队列读到记录
      }
    }
  }

  /**
   * 将磁盘合并结果采纳到当前标签页：
   * - 远端更新且本页未改：静默跟进最新版本
   * - 远端更新但本页也有未提交修改：本页内容进 stash 保留，弹出冲突提示并列出差异字段
   * - 持久化冲突队列中指向本标签页的记录：说明本页已保存的版本被对方提交覆盖，提示并保留快照
   * - 合并后实际胜出的是本页内容：不提示（其他标签页会自行协调）
   */
  function reconcile(merged: SharedState, sourceLabel?: string) {
    const base = knownRemote
    const nextSessions = new Map(merged.sessions.map((session) => [session.id, session]))
    const nextNotices = [...conflictNotices.value.filter((notice) => !notice.conflictId)]

    // 1) 未提交本地编辑与远端保存撞车（内存检测）
    for (const baseSession of base.sessions) {
      const localSession = sessions.value.find((item) => item.id === baseSession.id)
      const mergedSession = nextSessions.get(baseSession.id)
      if (!localSession) continue
      const localChanged = JSON.stringify(localSession) !== JSON.stringify(baseSession)
      if (!localChanged) continue
      const remoteChanged =
        !mergedSession || JSON.stringify(mergedSession) !== JSON.stringify(baseSession)
      if (!remoteChanged) continue
      // 本页未提交内容在合并中胜出（revision 更高），无需提示
      if (mergedSession && JSON.stringify(mergedSession) === JSON.stringify(localSession)) continue

      const existing = nextNotices.find((item) => item.sessionId === localSession.id && !item.conflictId)
      const fields = mergedSession ? diffSessions(localSession, mergedSession) : []
      if (mergedSession && !fields.length) continue
      if (existing) {
        existing.fields = fields
        existing.stash = cloneSession(localSession)
        existing.reason = mergedSession ? 'updated' : 'deleted'
        existing.at = nowIso()
      } else {
        nextNotices.unshift({
          sessionId: localSession.id,
          sessionName: localSession.name,
          clientLabel: mergedSession?.updatedBy || sourceLabel || '其他标签页',
          fields,
          reason: mergedSession ? 'updated' : 'deleted',
          stash: cloneSession(localSession),
          at: nowIso(),
        })
      }
    }

    // 2) 持久化冲突队列：只并入精确属于本标签页、尚未消除的记录
    for (const conflict of merged.conflicts) {
      if (conflict.loserClientId !== clientId || conflict.resolvedBy.includes(clientId)) continue
      if (!nextNotices.some((notice) => notice.conflictId === conflict.id)) {
        nextNotices.unshift(conflictToNotice(conflict))
      }
    }
    const liveIds = new Set(
      merged.conflicts
        .filter((conflict) => conflict.loserClientId === clientId && !conflict.resolvedBy.includes(clientId))
        .map((conflict) => conflict.id),
    )
    const keptNotices = nextNotices.filter(
      (notice) => !notice.conflictId || liveIds.has(notice.conflictId),
    )

    conflictNotices.value = keptNotices
    saveStash(keptNotices)
    applyMerged(merged)
    dirtyIds = new Set()
  }

  /** 把合并结果写入响应式状态、更新 revision 基线与水位（不做冲突检测） */
  function applyMerged(merged: SharedState) {
    sessions.value = merged.sessions.map(cloneSession)
    revisionWatermark = Math.max(revisionWatermark, ...merged.sessions.map((session) => session.revision))
    for (const session of merged.sessions) sessionBaseRevisions.set(session.id, session.revision)
    templates.value = merged.templates.map((template) => ({ ...template, points: [...template.points] }))
    quarantine.value = merged.quarantine.map((item) => ({ ...item }))
    backups.value = merged.backups.map((item) => ({ ...item, samples: [...item.samples] }))
    conflicts.value = merged.conflicts
    if (!sessions.value.some((session) => session.id === activeSessionId.value)) {
      activeSessionId.value = sessions.value[0]?.id ?? ''
    }
    overlaySessionIds.value = overlaySessionIds.value.filter((id) => sessions.value.some((session) => session.id === id))
  }

  /** 发布前/启动后的静默同步：只拉取持久化冲突队列并更新基线，不把本地内容误判为未提交冲突 */
  function adoptRemote(merged: SharedState) {
    const nextNotices = [...conflictNotices.value.filter((notice) => !notice.conflictId)]
    // 持久化冲突只通知精确的被覆盖方标签页，无关标签页不受打扰
    for (const conflict of merged.conflicts) {
      if (conflict.loserClientId !== clientId || conflict.resolvedBy.includes(clientId)) continue
      if (!nextNotices.some((notice) => notice.conflictId === conflict.id)) {
        nextNotices.unshift(conflictToNotice(conflict))
      }
    }
    const liveIds = new Set(
      merged.conflicts
        .filter((conflict) => conflict.loserClientId === clientId && !conflict.resolvedBy.includes(clientId))
        .map((conflict) => conflict.id),
    )
    conflictNotices.value = nextNotices.filter(
      (notice) => !notice.conflictId || liveIds.has(notice.conflictId),
    )
    saveStash(conflictNotices.value)
    applyMerged(merged)
    dirtyIds = new Set()
  }

  function markConflictResolved(conflictId: string) {
    const conflict = conflicts.value.find((item) => item.id === conflictId)
    if (conflict && !conflict.resolvedBy.includes(clientId)) {
      conflict.resolvedBy = [...conflict.resolvedBy, clientId]
    }
  }

  function persist() {
    // 给本事务改动的窑次在读取磁盘后盖一个严格更大的 revision，
    // 使其在三方合并中胜出；detectCommittedConflicts 已先把被覆盖方快照持久化
    const disk = loadShared()
    const local = toShared()
    if (disk.state) {
      revisionWatermark = Math.max(
        revisionWatermark,
        ...disk.state.sessions.map((session) => session.revision),
      )
      detectCommittedConflicts(local, disk.state)
    }
    if (disk.corrupted) local.quarantine.unshift(disk.corrupted)
    // 冲突记录已在 detect 中加入 local.conflicts（toShared 之后的增量需要重新带上）
    local.conflicts = conflicts.value.map((item) => ({
      ...item,
      fields: item.fields.map((field) => ({ ...field })),
      loserSnapshot: cloneSession(item.loserSnapshot),
      resolvedBy: [...item.resolvedBy],
    }))
    const merged = disk.state ? mergeShared(local, disk.state) : local
    merged.lastClient = clientId
    commitShared(merged)
    reconcile(merged)
    knownRemote = cloneShared(merged)
    saveTabPrefs({ activeSessionId: activeSessionId.value, overlaySessionIds: overlaySessionIds.value })
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

  /**
   * 标记一次内容修改：revision 自增，供其他标签页检测；
   * 冻结过复核且本次改动了冻结维度时，窑次回到待复核，旧复核立即标记过期。
   */
  function touch(session: KilnSession, options: { basisAffected?: boolean } = {}) {
    revisionWatermark = Math.max(revisionWatermark, session.revision) + 1
    session.revision = revisionWatermark
    session.updatedAt = nowIso()
    session.updatedById = clientId
    session.updatedBy = clientLabel
    dirtyIds.add(session.id)
    if (options.basisAffected && session.reviews.length) {
      session.status = 'review'
    }
  }

  function restore(snapshotState: { sessions: KilnSession[]; activeSessionId: string }) {
    const restoredIds = new Set(snapshotState.sessions.map((session) => session.id))
    const currentMap = new Map(sessions.value.map((session) => [session.id, session]))
    sessions.value = snapshotState.sessions.map((restored) => {
      const current = currentMap.get(restored.id)
      if (current) {
        // 快照之后发布的复核版本做并集，撤销编辑不应抹掉已发布的历史复核
        const known = new Set(restored.reviews.map((review) => review.id))
        restored.reviews = [
          ...restored.reviews,
          ...current.reviews.filter((review) => !known.has(review.id)),
        ].sort((a, b) => a.version - b.version)
      }
      if (!current || JSON.stringify(current) !== JSON.stringify(restored)) {
        touch(restored)
      }
      return cloneSession(restored)
    })
    // 撤销删除时，同步撤销这些窑次的墓碑，避免持久化时被再次删除
    knownRemote = {
      ...knownRemote,
      tombstones: knownRemote.tombstones.filter((tomb) => !restoredIds.has(tomb.id)),
    }
    activeSessionId.value = snapshotState.activeSessionId
    selectedPointId.value = activeSession.value?.points[0]?.id ?? null
    selectedStageIndex.value = 0
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
    saveTabPrefs({ activeSessionId: activeSessionId.value, overlaySessionIds: overlaySessionIds.value })
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
    touch(session, { basisAffected: true })
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
    touch(activeSession.value, { basisAffected: true })
    selectedPointId.value = point.id
    selectedStageIndex.value = stageIndex + 1
    persist()
  }

  function removePoint(pointId: string) {
    if (activeSession.value.points.length <= 3) return
    recordHistory()
    activeSession.value.points = activeSession.value.points.filter((point) => point.id !== pointId)
    touch(activeSession.value, { basisAffected: true })
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    selectedStageIndex.value = 0
    persist()
  }

  function applyTemplate(templateId: string) {
    const template = templates.value.find((item) => item.id === templateId)
    if (!template) return
    recordHistory()
    const session = activeSession.value
    session.points = templateToPoints(template, session.id)
    session.clay = template.clay
    session.glaze = template.glaze
    touch(session, { basisAffected: true })
    selectedPointId.value = session.points[0]?.id ?? null
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
      updatedAt: nowIso(),
    }
    templates.value.unshift(template)
    persist()
  }

  /* ---------------- 版本化复核 ---------------- */

  function publishReview(
    note?: string,
    options: { useStashed?: boolean } = {},
  ): { ok: true; review: ReviewSnapshot } | { ok: false; reason: 'conflict' | 'no-samples' } {
    const session = activeSession.value
    if (!session.actualSamples.length) return { ok: false, reason: 'no-samples' }
    // 发布前先与磁盘静默同步：更新基线并拉取针对本标签页的持久化冲突，
    // 但不把本地内容误判为“未提交冲突”
    const disk = loadShared()
    if (disk.state) {
      const merged = mergeShared(toShared(), disk.state)
      adoptRemote(merged)
      knownRemote = cloneShared(merged)
    }
    const notice = conflictNotices.value.find((item) => item.sessionId === session.id)
    if (notice) {
      if (!options.useStashed) return { ok: false, reason: 'conflict' }
      // 用户明确选择“保留我的修改”：以未提交内容为基线，且保留对方已发布的复核历史
      keepStashedChanges(session.id)
    }
    const target = activeSession.value
    const review = createReviewSnapshot(target, { clientId, clientLabel, note })
    target.reviews = [...target.reviews, review]
    target.lastReviewId = review.id
    target.status = 'completed'
    touch(target)
    persist()
    return { ok: true, review }
  }

  function dismissConflict(discardStash: boolean, sessionId?: string) {
    if (!discardStash) return
    const target =
      conflictNotices.value.find((item) => item.sessionId === sessionId) ?? conflictNotices.value[0]
    if (!target) return
    if (target.conflictId) {
      // 持久化冲突：标记本标签页已处理并写回，避免刷新后重复提示
      markConflictResolved(target.conflictId)
    }
    conflictNotices.value = conflictNotices.value.filter((item) => item !== target)
    saveStash(conflictNotices.value)
    persist()
  }

  /** 冲突提示中“保留我的修改”：把未提交/被覆盖快照作为新版本写回，revision 高于远端以胜出合并 */
  function keepStashedChanges(sessionId?: string) {
    const notice =
      conflictNotices.value.find((item) => item.sessionId === sessionId) ?? conflictNotices.value[0]
    if (!notice?.stash) return
    const stashed = notice.stash
    const current = sessions.value.find((item) => item.id === stashed.id)
    if (current) {
      // 远端新增的复核版本保留，避免“我的修改”覆盖对方已发布的复核
      const mergedReviews = new Map<string, ReviewSnapshot>()
      for (const review of stashed.reviews) mergedReviews.set(review.id, review)
      for (const review of current.reviews) {
        if (!mergedReviews.has(review.id)) mergedReviews.set(review.id, review)
      }
      stashed.reviews = [...mergedReviews.values()].sort((a, b) => a.version - b.version)
      if (!stashed.lastReviewId && current.lastReviewId) stashed.lastReviewId = current.lastReviewId
    }
    revisionWatermark = Math.max(revisionWatermark, current?.revision ?? 0) + 1
    stashed.revision = revisionWatermark
    stashed.updatedAt = nowIso()
    stashed.updatedById = clientId
    stashed.updatedBy = `${clientLabel}（恢复未提交修改）`
    dirtyIds.add(stashed.id)
    if (current) {
      sessions.value = sessions.value.map((item) => (item.id === stashed.id ? stashed : item))
    } else {
      sessions.value = [...sessions.value, stashed]
    }
    // 恢复被删窑次需要撤销其墓碑
    knownRemote = {
      ...knownRemote,
      tombstones: knownRemote.tombstones.filter((tomb) => tomb.id !== stashed.id),
    }
    activeSessionId.value = stashed.id
    if (notice.conflictId) markConflictResolved(notice.conflictId)
    conflictNotices.value = conflictNotices.value.filter((item) => item !== notice)
    saveStash(conflictNotices.value)
    persist()
  }

  /* ---------------- 记录仪导入：备份与隔离 ---------------- */

  function pushBackup(session: KilnSession, reason: 'import-replace' | 'import-failed') {
    if (!session.actualSamples.length) return
    const backup = {
      id: `backup-${crypto.randomUUID()}`,
      sessionId: session.id,
      createdAt: nowIso(),
      reason,
      samples: session.actualSamples.map((sample) => ({ ...sample })),
    }
    const own = backups.value
      .filter((item) => item.sessionId === session.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const expired = own.slice(BACKUPS_PER_SESSION - 1).map((item) => item.id)
    backups.value = [...backups.value.filter((item) => !expired.includes(item.id)), backup]
  }

  function importSamples(samples: FiringSample[], badRows: string[], rawText?: string, reason?: string) {
    recordHistory()
    const session = activeSession.value
    pushBackup(session, 'import-replace')
    session.actualSamples = samples
    session.status = 'review'
    touch(session, { basisAffected: true })
    if (badRows.length) {
      quarantine.value.push({
        id: `q-${crypto.randomUUID()}`,
        createdAt: nowIso(),
        kind: 'csv-rows',
        reason: reason ?? `${session.name} 导入时有 ${badRows.length} 行异常记录被隔离。`,
        sessionId: session.id,
        sessionName: session.name,
        badRows,
        rawText: rawText?.slice(0, 200_000),
      })
    }
    persist()
  }

  /** 整个文件无法解析时：不动现有实测，原文隔离以便重试/下载 */
  function quarantineCsvFile(rawText: string, reason: string, badRows: string[] = []) {
    quarantine.value.push({
      id: `q-${crypto.randomUUID()}`,
      createdAt: nowIso(),
      kind: 'csv-rows',
      reason,
      sessionId: activeSession.value.id,
      sessionName: activeSession.value.name,
      badRows,
      rawText: rawText.slice(0, 200_000),
    })
    persist()
  }

  function clearActualSamples() {
    recordHistory()
    const session = activeSession.value
    pushBackup(session, 'import-replace')
    session.actualSamples = []
    touch(session, { basisAffected: true })
    persist()
  }

  function restoreBackup(backupId: string) {
    const backup = backups.value.find((item) => item.id === backupId)
    if (!backup) return
    const session = sessions.value.find((item) => item.id === backup.sessionId)
    if (!session) return
    recordHistory()
    pushBackup(session, 'import-replace')
    session.actualSamples = backup.samples.map((sample) => ({ ...sample }))
    session.status = 'review'
    touch(session, { basisAffected: true })
    persist()
  }

  function discardBackup(backupId: string) {
    backups.value = backups.value.filter((item) => item.id !== backupId)
    persist()
  }

  function removeQuarantine(id: string) {
    quarantine.value = quarantine.value.filter((item) => item.id !== id)
    persist()
  }

  function clearQuarantine() {
    quarantine.value = []
    persist()
  }

  function setTimeOffset(offsetMin: number) {
    const session = activeSession.value
    session.timeOffsetMin = Number(offsetMin.toFixed(1))
    touch(session, { basisAffected: true })
    persist()
  }

  function updateSessionMeta(patch: Partial<Pick<KilnSession, 'name' | 'kiln' | 'clay' | 'glaze' | 'firedAt' | 'status'>>) {
    recordHistory()
    const session = activeSession.value
    const basisAffected = 'clay' in patch || 'glaze' in patch
    Object.assign(session, patch)
    touch(session, { basisAffected: false })
    if (basisAffected && session.reviews.length && !('status' in patch)) session.status = 'review'
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
      lastReviewId: undefined,
      revision: 1,
      updatedAt: nowIso(),
      updatedById: clientId,
      updatedBy: clientLabel,
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
    knownRemote.tombstones = [
      ...knownRemote.tombstones.filter((tomb) => tomb.id !== id),
      { id, at: nowIso() },
    ]
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
    saveTabPrefs({ activeSessionId: activeSessionId.value, overlaySessionIds: overlaySessionIds.value })
  }

  function handleStorageEvent() {
    const disk = loadShared()
    if (!disk.state) return
    const merged = mergeShared(toShared(), disk.state)
    const remoteClient = disk.state.lastClient
    reconcile(merged, remoteClient ? '其他标签页' : undefined)
    knownRemote = cloneShared(merged)
  }

  function exportSessionJson() {
    const state = reviewState(activeSession.value)
    const payload = {
      schema: 'kiln-firing-curve/v2',
      exportedAt: new Date().toISOString(),
      session: activeSession.value,
      liveValidation: validationIssues.value,
      latestReview: state.review
        ? {
            version: state.review.version,
            publishedAt: state.review.publishedAt,
            staleFields: state.stale,
            frozen: {
              risks: state.review.risks,
              deviation: state.review.deviation,
            },
          }
        : null,
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
    // state
    sessions,
    templates,
    quarantine,
    backups,
    activeSessionId,
    activeSession,
    activeReview,
    selectedPointId,
    selectedStageIndex,
    overlaySessionIds,
    visibleSessions,
    validationIssues,
    canUndo,
    canRedo,
    conflictNotice,
    conflictNotices,
    quarantineCount,
    activeBackups,
    clientLabel,
    // history
    undo,
    redo,
    beginDrag,
    endDrag,
    setActiveSession,
    // curve editing
    updatePoint,
    addPointAfterStage,
    removePoint,
    applyTemplate,
    saveTemplateFromSession,
    // reviews
    publishReview,
    dismissConflict,
    keepStashedChanges,
    // samples
    importSamples,
    quarantineCsvFile,
    clearActualSamples,
    restoreBackup,
    discardBackup,
    // quarantine
    removeQuarantine,
    clearQuarantine,
    // time offset & meta
    setTimeOffset,
    updateSessionMeta,
    // sessions
    addSession,
    removeSession,
    toggleOverlay,
    exportSessionJson,
    // cross-tab
    handleStorageEvent,
  }
})
