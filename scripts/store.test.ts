class MemoryStorage {
  map = new Map<string, string>()
  get length() { return this.map.size }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) { this.map.set(k, String(v)) }
  removeItem(k: string) { this.map.delete(k) }
  clear() { this.map.clear() }
  key(i: number) { return [...this.map.keys()][i] ?? null }
}
const localStorage = new MemoryStorage()
const sessionStorages = new Map<string, MemoryStorage>()
let currentTab = 'A'
;(globalThis as any).localStorage = localStorage
;(globalThis as any).window = { localStorage, addEventListener() {}, removeEventListener() {} }
Object.defineProperty(globalThis, 'sessionStorage', {
  get: () => { if (!sessionStorages.has(currentTab)) sessionStorages.set(currentTab, new MemoryStorage()); return sessionStorages.get(currentTab)! },
})
;(globalThis.crypto as any).randomUUID = () => 'uuid-' + Math.random().toString(36).slice(2, 10)
const RealURL = globalThis.URL
;(globalThis as any).URL = class extends RealURL { static createObjectURL(){return 'blob:x'} static revokeObjectURL(){} }
;(globalThis as any).document = { createElement: () => ({ click() {} }) }

import { createServer } from 'vite'
import { createPinia, setActivePinia } from 'pinia'

let assertCount = 0
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 }
  else { assertCount++; console.log('PASS:', msg) }
}
const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error' })
async function freshStore(tab: string) {
  currentTab = tab
  setActivePinia(createPinia())
  await server.moduleGraph.invalidateAll()
  return (await server.ssrLoadModule('/src/stores/firingStore.ts')).useFiringStore()
}

/* A 发布复核 */
const storeA = await freshStore('A')
const sid = storeA.sessions[0].id
storeA.setActiveSession(sid)
const seedReviews = storeA.activeSession.reviews.length
const pubA = storeA.publishReview('A 发布')
assert(pubA.ok === true, 'A 发布复核成功')
assert(storeA.activeSession.reviews.length === seedReviews + 1, '冻结版本已保存')

const storeB = await freshStore('B')
storeB.setActiveSession(sid)
assert(storeB.activeSession.reviews.length === seedReviews + 1, 'B 读到 A 发布的复核')

/* 场景一：B 已提交泥料，A 基于旧基线保存偏移 → B 不被静默覆盖 */
storeB.updateSessionMeta({ clay: '紫砂泥' })
storeA.setTimeOffset(42)
storeB.handleStorageEvent()
const n1: any = storeB.conflictNotice
assert(n1 !== null && !!n1.conflictId, 'B 收到持久化冲突提示')
assert(n1?.fields.some((f: any) => f.label === '泥料'), '差异包含被覆盖的泥料')
assert(n1?.stash?.clay === '紫砂泥', 'B 被覆盖版本完整保留')
assert(storeB.activeSession.timeOffsetMin === 42, 'B 工作区显示 A 的最新版本（偏移 42）')
assert(storeA.conflictNotice === null, 'A 覆盖方不收到自我提示')
storeB.keepStashedChanges(sid)
assert(storeB.activeSession.clay === '紫砂泥', 'B 一键恢复被覆盖的泥料')

/* 场景二：A、B 各自再改一个字段，B 先于 A 事件前保存，A 保存后 B 收到冲突 */
storeB.dismissConflict(true, sid)
storeB.updateSessionMeta({ glaze: '结晶釉' })
storeA.updateSessionMeta({ name: '并发窑次名称' })
storeB.handleStorageEvent()
const n2: any = storeB.conflictNotice
assert(n2 !== null, 'B 检测到并发保存冲突')
assert(n2?.fields.some((f: any) => f.label === '釉料'), '差异包含 B 的釉料')
assert(n2?.fields.some((f: any) => f.label === '窑次名称'), '差异包含 A 的名称')
assert(n2?.stash?.glaze === '结晶釉', 'B 的釉料未提交内容保留')
storeB.dismissConflict(true, sid) // B 采用 A 的版本

/* 场景三：复核追加而非覆盖（干净的第三个标签页） */
const storeC = await freshStore('C')
storeC.setActiveSession(sid)
const before = storeC.activeSession.reviews.length
let pubC = storeC.publishReview('C 的复核')
if (pubC.ok === false && pubC.reason === 'conflict') {
  storeC.dismissConflict(true, sid)
  pubC = storeC.publishReview('C 的复核')
}
assert(pubC.ok === true, `C 处理冲突后发布成功（${pubC.ok ? 'ok' : pubC.reason}）`)
assert(storeC.activeSession.reviews.length === before + 1, '复核版本追加而非覆盖')

/* 场景四：冻结后改曲线 → 旧复核逐项过期；撤销恢复有效 */
storeC.updatePoint(storeC.activeSession.points[1].id, storeC.activeSession.points[1].timeMin, storeC.activeSession.points[1].tempC + 25)
const stale = storeC.activeReview.stale.map((s: any) => String(s))
assert(stale.includes('points') && stale.includes('risk'), `旧复核标记 曲线/风险 过期（实际 ${stale.join(',')}）`)
assert(storeC.activeSession.status === 'review', '过期后自动回到待复核')
storeC.undo()
assert(storeC.activeReview.stale.length === 0, '撤销曲线改动后旧复核恢复有效')

/* 场景五：冲突记录随存储持久化，冷启动安全加载 */
const storeD = await freshStore('D')
storeD.setActiveSession(sid)
assert(storeD.activeSession.id === sid, '新标签页冷启动正常加载窑次')

await server.close()
console.log(`\n${assertCount} assertions passed`)
