export interface FiringPoint {
  id: string
  timeMin: number
  tempC: number
}

export interface FiringSample {
  id: string
  timeMin: number
  tempC: number
}

export type StageType = 'heat' | 'hold' | 'cool'

export interface FiringStage {
  id: string
  index: number
  type: StageType
  start: FiringPoint
  end: FiringPoint
  durationMin: number
  deltaTemp: number
  ratePerMin: number
}

export interface CurveTemplate {
  id: string
  name: string
  clay: string
  glaze: string
  peakTempC: number
  description: string
  points: Array<Omit<FiringPoint, 'id'>>
  updatedAt: string
}

/** 复核冻结的字段维度，用于逐项判断哪一项已过期 */
export type ReviewFieldKey = 'points' | 'timeOffset' | 'samples' | 'materials'

/** 过期提示维度：四个冻结项 + 风险判断（随曲线/材料变化失效） */
export type StaleField = ReviewFieldKey | 'risk'

export interface ReviewSnapshot {
  id: string
  /** 同一窑次内自增的版本号 */
  version: number
  publishedAt: string
  /** 发布来源标签页标识 */
  clientId: string
  clientLabel: string
  clay: string
  glaze: string
  /** 冻结的目标曲线关键点 */
  points: FiringPoint[]
  /** 冻结的时间偏移（分钟） */
  timeOffsetMin: number
  /** 冻结的记录仪实测采样 */
  actualSamples: FiringSample[]
  /** 冻结的风险判断 */
  risks: RiskIssue[]
  /** 冻结的偏差统计 */
  deviation: DeviationSummary
  /** 各冻结维度的内容哈希，用于后续比对 */
  basis: Record<ReviewFieldKey, string>
  note?: string
}

/** 导入新记录前自动备份的上一版实测数据 */
export interface SampleBackup {
  id: string
  sessionId: string
  createdAt: string
  reason: 'import-replace' | 'import-failed'
  samples: FiringSample[]
}

/** 被隔离的坏记录（损坏持久化、坏窑次、坏模板、坏 CSV 原文等），始终可恢复 */
export interface QuarantineItem {
  id: string
  createdAt: string
  kind: 'storage-raw' | 'session-record' | 'template-record' | 'csv-rows'
  reason: string
  sessionId?: string
  sessionName?: string
  /** 原始 CSV 文本 / JSON 文本 */
  rawText?: string
  /** CSV 坏行 */
  badRows?: string[]
  /** 尚能解析出的记录（坏窑次隔离时携带） */
  record?: unknown
}

export interface ConflictFieldInfo {
  field: 'name' | 'kiln' | 'clay' | 'glaze' | 'firedAt' | 'points' | 'timeOffsetMin' | 'actualSamples'
  label: string
  localValue: string
  remoteValue: string
}

export interface ConflictNotice {
  /** 持久化冲突记录 id；纯内存检测时为空 */
  conflictId?: string
  sessionId: string
  sessionName: string
  clientLabel: string
  fields: ConflictFieldInfo[]
  reason: 'updated' | 'deleted'
  /** 本标签页未提交内容（或被删窑次/被覆盖快照）的完整数据，可一键恢复 */
  stash?: KilnSession
  at: string
}

/**
 * 持久化的并发冲突记录：当标签页基于旧基线提交并覆盖了另一标签页已保存的版本时，
 * 被覆盖方的完整快照随共享存储一起带走，保证该标签页刷新/收到事件时仍能提示并恢复，
 * 不会出现“后保存静默盖掉先保存”的数据丢失。
 */
export interface SessionConflict {
  id: string
  sessionId: string
  sessionName: string
  winnerClientId: string
  winnerClientLabel: string
  loserClientId: string
  loserClientLabel: string
  loserSnapshot: KilnSession
  fields: ConflictFieldInfo[]
  reason: 'updated' | 'deleted'
  at: string
  /** 已查看并消除该提示的标签页 */
  resolvedBy: string[]
}

export interface KilnSession {
  id: string
  name: string
  kiln: string
  clay: string
  glaze: string
  firedAt: string
  status: 'draft' | 'completed' | 'review'
  timeOffsetMin: number
  points: FiringPoint[]
  actualSamples: FiringSample[]
  /** 每次内容修改自增，用于多标签页最后写入检测 */
  revision: number
  updatedAt: string
  /** 最后写入的标签页 id（用于把并发冲突精确通知到被覆盖方） */
  updatedById?: string
  /** 最后写入的标签页 */
  updatedBy?: string
  /** 已发布的复核版本，按 version 升序 */
  reviews: ReviewSnapshot[]
  /** 最近一次发布的复核 id（可能已过期） */
  lastReviewId?: string
}

export interface RiskIssue {
  id: string
  stageIndex: number
  severity: 'error' | 'warning'
  title: string
  message: string
  metric: string
}

export interface DeviationSummary {
  sampleCount: number
  meanAbs: number
  maxAbs: number
  maxAtMin: number
  maxTarget: number
  maxActual: number
}

/** CSV 解析结果：有效记录与坏行分离 */
export interface CsvParseResult {
  samples: FiringSample[]
  badRows: string[]
  reason?: string
}
