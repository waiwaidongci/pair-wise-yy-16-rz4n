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

export type ReviewStaleKey = 'curve' | 'offset' | 'samples'

export interface ReviewSnapshot {
  points: FiringPoint[]
  timeOffsetMin: number
  actualSamples: FiringSample[]
}

export interface FiringReview {
  id: string
  version: number
  publishedAt: string
  note: string
  /** migration = 升级前补录的复核，manual = 发布时冻结的复核 */
  origin: 'manual' | 'migration'
  snapshot: ReviewSnapshot
  riskIssues: RiskIssue[]
  deviation: DeviationSummary
}

export interface SampleBackup {
  samples: FiringSample[]
  savedAt: string
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
  reviews: FiringReview[]
  sampleBackup: SampleBackup | null
}

export interface QuarantinedRecord {
  id: string
  kind: 'session' | 'template'
  reason: string
  foundAt: string
  raw: unknown
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
