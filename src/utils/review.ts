import type {
  DeviationSummary,
  FiringPoint,
  FiringSample,
  KilnSession,
  ReviewFieldKey,
  ReviewSnapshot,
  StaleField,
} from '../types/firing'
import { hashPoints, hashSamples, stableHash } from './hash'
import { calculateDeviation, validateCurve } from './curve'

export const REVIEW_FIELD_LABELS: Record<ReviewFieldKey, string> = {
  points: '目标曲线',
  timeOffset: '时间偏移',
  samples: '实测采样',
  materials: '泥料 / 釉料',
}

/** 会话当前各复核维度的内容指纹 */
export function sessionBasis(session: {
  points: FiringPoint[]
  timeOffsetMin: number
  actualSamples: FiringSample[]
  clay: string
  glaze: string
}): Record<ReviewFieldKey, string> {
  return {
    points: hashPoints(session.points),
    timeOffset: stableHash(Number(session.timeOffsetMin ?? 0)),
    samples: hashSamples(session.actualSamples),
    materials: stableHash({ clay: session.clay, glaze: session.glaze }),
  }
}

/** 相对某个冻结版本，当前已经过期的维度；风险在曲线/泥料釉料变化时过期 */
export function staleFieldsSince(review: ReviewSnapshot, session: KilnSession): StaleField[] {
  const basis = sessionBasis(session)
  const stale: StaleField[] = (Object.keys(REVIEW_FIELD_LABELS) as ReviewFieldKey[]).filter(
    (key) => basis[key] !== review.basis[key],
  )
  // 风险结果由目标曲线与泥料/釉料规则决定：这两项变化时风险判断同步失效
  if (stale.includes('points') || stale.includes('materials')) stale.push('risk')
  return stale
}

export const STALE_FIELD_LABELS: Record<StaleField, string> = {
  ...REVIEW_FIELD_LABELS,
  risk: '风险判断',
}

export function latestReview(session: KilnSession): ReviewSnapshot | null {
  if (!session.reviews?.length) return null
  return session.reviews.reduce((newest, review) =>
    review.version > newest.version ? review : newest,
  )
}

/** 当前最新复核是否仍有效（任何一项冻结内容变化即失效） */
export function reviewState(session: KilnSession) {
  const review = latestReview(session)
  if (!review) return { review: null as ReviewSnapshot | null, stale: [] as StaleField[], fresh: false }
  const stale = staleFieldsSince(review, session)
  return { review, stale, fresh: stale.length === 0 }
}

/** 冻结当前窑次生成复核版本 */
export function createReviewSnapshot(
  session: KilnSession,
  context: { clientId: string; clientLabel: string; note?: string; publishedAt?: string },
): ReviewSnapshot {
  const version = (latestReview(session)?.version ?? 0) + 1
  const points = session.points.map((point) => ({ ...point }))
  const actualSamples = session.actualSamples.map((sample) => ({ ...sample }))
  const deviation: DeviationSummary = calculateDeviation(points, actualSamples, session.timeOffsetMin)
  return {
    id: `review-${crypto.randomUUID()}`,
    version,
    publishedAt: context.publishedAt ?? new Date().toISOString(),
    clientId: context.clientId,
    clientLabel: context.clientLabel,
    clay: session.clay,
    glaze: session.glaze,
    points,
    timeOffsetMin: session.timeOffsetMin,
    actualSamples,
    risks: validateCurve({ ...session, points, actualSamples }),
    deviation,
    basis: sessionBasis(session),
    note: context.note,
  }
}

/** 用冻结版本构造一个只读的探针窑次（供阶段/风险/偏差复算展示） */
export function snapshotToSession(snapshot: ReviewSnapshot): KilnSession {
  return {
    id: `review-${snapshot.version}`,
    name: `复核 v${snapshot.version}`,
    kiln: '',
    clay: snapshot.clay,
    glaze: snapshot.glaze,
    firedAt: snapshot.publishedAt,
    status: 'completed',
    timeOffsetMin: snapshot.timeOffsetMin,
    points: snapshot.points.map((point) => ({ ...point })),
    actualSamples: snapshot.actualSamples.map((sample) => ({ ...sample })),
    revision: 0,
    updatedAt: snapshot.publishedAt,
    reviews: [],
  }
}

/** 按当前数据重新计算偏差（旧复核失效后页面展示的“实时结果”） */
export function liveDeviation(session: KilnSession): DeviationSummary {
  return calculateDeviation(session.points, session.actualSamples, session.timeOffsetMin)
}
