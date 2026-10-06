import { sanitizeShared, mergeShared } from '../src/utils/persistence.ts'
import { createReviewSnapshot, staleFieldsSince, reviewState } from '../src/utils/review.ts'
import { parseTemperatureCsv } from '../src/utils/csv.ts'

let pass = 0
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 }
  else { pass++; console.log('PASS:', msg) }
}

// 1) v1 旧数据仍能读取（旧结构无 revision/reviews）
const v1 = {
  sessions: [{
    id: 'old-1', name: '旧窑次', kiln: 'k', clay: '青瓷泥', glaze: '天青釉', firedAt: 'x',
    status: 'completed', timeOffsetMin: 2,
    points: [{ id: 'p1', timeMin: 0, tempC: 20 }, { id: 'p2', timeMin: 100, tempC: 1200 }],
    actualSamples: [{ id: 's1', timeMin: 0, tempC: 20 }],
  }],
  templates: [{
    id: 't1', name: '旧模板', clay: 'c', glaze: 'g', peakTempC: 1200, description: '',
    points: [{ timeMin: 0, tempC: 20 }, { timeMin: 100, tempC: 1200 }], updatedAt: '2026-01-01',
  }],
  activeSessionId: 'old-1', overlaySessionIds: [],
}
{
  const { state, quarantine } = sanitizeShared(v1)
  assert(state.sessions.length === 1, 'v1 旧窑次可读')
  assert(state.sessions[0].revision === 0, 'v1 revision 默认 0')
  assert(Array.isArray(state.sessions[0].reviews) && state.sessions[0].reviews.length === 0, 'v1 reviews 默认空数组')
  assert(state.templates.length === 1, 'v1 旧模板可读')
  assert(quarantine.length === 0, 'v1 正常数据不产生隔离')
}

// 2) 坏窑次记录隔离，好记录保留
{
  const bad = JSON.parse(JSON.stringify(v1))
  bad.sessions.push({ id: 'broken', points: 'not-array' })
  bad.sessions.push({ nope: true })
  const { state, quarantine } = sanitizeShared(bad)
  assert(state.sessions.length === 1, '坏窑次被剔除，好窑次保留')
  assert(quarantine.length === 2, '两条坏记录被隔离')
  assert(quarantine.every(q => q.kind === 'session-record'), '隔离类型为 session-record')
  assert(JSON.parse(quarantine[0].rawText!).id === 'broken' || JSON.parse(quarantine[1].rawText!).id === 'broken', '隔离记录保留原文可恢复')
}

// 3) 坏模板隔离
{
  const bad = JSON.parse(JSON.stringify(v1))
  bad.templates.push({ id: 'bt', points: [] })
  const { state, quarantine } = sanitizeShared(bad)
  assert(state.templates.length === 1 && quarantine.length === 1, '坏模板隔离不影响好模板')
}

// 4) 采样中混入坏行被清洗
{
  const bad = JSON.parse(JSON.stringify(v1))
  bad.sessions[0].actualSamples.push({ id: 'x', timeMin: 'oops', tempC: 500 }, { id: 'y', timeMin: 5, tempC: 99999 })
  const { state } = sanitizeShared(bad)
  assert(state.sessions[0].actualSamples.length === 1, '坏采样行被清洗')
}

// 5) CSV：好行与坏行分离
{
  const csv = 'time,temp\n0,20\n5,100\nbad,row\n10,200\n'
  const r = parseTemperatureCsv(csv)
  assert(r.samples.length === 3, `CSV 好行解析 3 行（实际 ${r.samples.length}）`)
  assert(r.badRows.length === 1, 'CSV 坏行隔离')
  const empty = parseTemperatureCsv('x,y\na,b\nc,d')
  assert(empty.samples.length === 0 && empty.badRows.length === 3, '全坏文件 0 导入（位置模式含首行）')
  const tc = parseTemperatureCsv('time,temp\n01:00,600\n')
  assert(Math.abs(tc.samples[0].timeMin - 60) < 1e-6, 'hh:mm 时间换算为分钟')
  const tc3 = parseTemperatureCsv('时间,温度\n01:00:30,600\n')
  assert(Math.abs(tc3.samples[0].timeMin - 60.5) < 1e-6, 'hh:mm:ss 时间换算为分钟')
}

// 6) 复核冻结与过期判定
function makeSession() {
  return {
    id: 's1', name: 'n', kiln: 'k', clay: '青瓷泥', glaze: '天青釉', firedAt: '',
    status: 'review' as const, timeOffsetMin: 0,
    points: [{ id: 'a', timeMin: 0, tempC: 20 }, { id: 'b', timeMin: 100, tempC: 1200 }],
    actualSamples: [{ id: 'x', timeMin: 0, tempC: 20 }, { id: 'y', timeMin: 100, tempC: 1180 }],
    revision: 1, updatedAt: '2026-10-01T00:00:00Z', reviews: [] as any[],
  }
}
{
  const session = makeSession()
  const review = createReviewSnapshot(session, { clientId: 't1', clientLabel: 'tab1', publishedAt: '2026-10-02T00:00:00Z' })
  assert(review.version === 1 && review.risks.length >= 0 && review.deviation.sampleCount === 2, '发布冻结曲线/采样/风险/偏差')
  session.reviews.push(review)
  assert(reviewState(session).fresh, '冻结后无改动 → 复核有效')

  // 改时间偏移
  session.timeOffsetMin = 5
  let stale = staleFieldsSince(review, session)
  assert(stale.length === 1 && stale[0] === 'timeOffset', `偏移过期（实际 ${stale.join(',')}）`)
  session.timeOffsetMin = 0

  // 改曲线（点 id 不变，温度变）
  session.points[1].tempC = 1210
  stale = staleFieldsSince(review, session)
  assert(stale.includes('points') && stale.includes('risk'), '曲线变化 → 曲线和风险判断过期')
  session.points[1].tempC = 1200

  // 改实测
  session.actualSamples[1].tempC = 1000
  stale = staleFieldsSince(review, session)
  assert(stale.includes('samples') && !stale.includes('risk'), '采样变化 → 实测过期，风险不过期')
  session.actualSamples[1].tempC = 1180

  // 改泥料
  session.clay = '紫砂泥'
  stale = staleFieldsSince(review, session)
  assert(stale.includes('materials') && stale.includes('risk'), '泥料变化 → 材料和风险过期')

  // 重新生成点 id（如重新套模板）但内容不变 → 不过期
  session.clay = '青瓷泥'
  session.points = session.points.map(p => ({ ...p, id: crypto.randomUUID() }))
  assert(reviewState(session).fresh, '仅点 id 变化不判定过期')
}

// 7) 合并：revision 高者胜 + 复核版本并集 + 墓碑删除
{
  const a = makeSession()
  const b = makeSession()
  a.name = 'A'; b.name = 'B'; b.revision = 2; b.updatedAt = '2026-10-03T00:00:00Z'
  const reviewB = createReviewSnapshot(b, { clientId: 't2', clientLabel: 'tab2' })
  b.reviews = [reviewB]
  const stateA = { schema: 2 as const, sessions: [a], templates: [], quarantine: [], backups: [], conflicts: [], tombstones: [], lastClient: 't1' }
  const stateB = { schema: 2 as const, sessions: [b], templates: [], quarantine: [], backups: [], conflicts: [], tombstones: [], lastClient: 't2' }
  const merged = mergeShared(stateA, stateB)
  assert(merged.sessions[0].name === 'B', 'revision 高的窑次内容胜出（后保存不再无脑盖）')
  assert(merged.sessions[0].reviews.length === 1, '复核版本合并保留')

  // 墓碑晚于更新时间 → 删除
  const stateBdel = { ...stateB, tombstones: [{ id: 's1', at: '2026-10-10T00:00:00Z' }] }
  const mergedDel = mergeShared(stateA, stateBdel)
  assert(mergedDel.sessions.length === 0, '墓碑删除窑次')

  // 墓碑早于更新时间（删除后又编辑/恢复）→ 保留
  const stateBold = { ...stateB, tombstones: [{ id: 's1', at: '2026-09-01T00:00:00Z' }] }
  const mergedKeep = mergeShared(stateA, stateBold)
  assert(mergedKeep.sessions.length === 1, '旧墓碑不会删除更新后的窑次')
}

console.log(`\n${pass} assertions passed`)
