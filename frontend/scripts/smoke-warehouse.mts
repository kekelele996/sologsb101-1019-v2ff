/**
 * 冒烟测试：库房/修复室两本账的核心流转
 * 1. 播种后函台账与排队请求就位
 * 2. 出库：在库够 → 立即出库开工单；容量放满 → 排队
 * 3. 工位还回 → 库房在库数跟着回 + 排队按先后兑现
 * 4. 对账：库房借出 vs 工位在修；重报只留痕不改库房账
 * 5. 旧版备份（无函）导入 → 按函现有册数回填历史格位
 */
import 'fake-indexeddb/auto'
import { setActivePinia, createPinia } from 'pinia'

// localStorage 桩（readUiPrefs 等用）
const store = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear()
}

const { db, initDatabase, importSnapshot, buildLegacyCaseShelves, DB_VERSION } = await import('../src/utils/db')
const { useWarehouseStore } = await import('../src/stores/warehouseStore')
const { useWorkshopStore } = await import('../src/stores/workshopStore')
const { holdingVolumeIds } = await import('../src/types/workOrder')
const { borrowedCount } = await import('../src/types/caseShelf')

setActivePinia(createPinia())

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

await initDatabase()
const warehouse = useWarehouseStore()
const workshop = useWorkshopStore()
await warehouse.loadAll()
await workshop.loadOrders()

console.log('1. 播种')
const case01 = warehouse.caseById('case_01')
check('DB 版本为 v3', DB_VERSION === 3)
check('函甲-01 容量 2 / 在库 1', case01?.slotCapacity === 2 && case01?.inStockCount === 1)
check('chk_02 排队中（要 2 册）', warehouse.queuedRequests.length === 1 && warehouse.queuedRequests[0].count === 2)
check('工单 wo_01 在修 1 册、拆叶 5', workshop.orders.length === 1 && workshop.orders[0].removedLeafCount === 5)

console.log('2. 出库：在库够立即出库，容量放满排队')
const s1 = await warehouse.requestCheckout('case_02', 1)
check('函甲-02 领 1 册 → 立即出库', s1 === 'fulfilled')
check('函甲-02 在库 0', warehouse.caseById('case_02')?.inStockCount === 0)
const s2 = await warehouse.requestCheckout('case_02', 1)
check('函甲-02 再领 1 册 → 容量放满排队', s2 === 'queued')
await warehouse.loadAll()
check('排队请求变 2 条', warehouse.queuedRequests.length === 2)
const tooMany = await warehouse.requestCheckout('case_02', 5).then(() => 'ok').catch((e: Error) => e.message)
check('超过格位容量的申请被拒绝', typeof tooMany === 'string' && tooMany.includes('格位容量'), String(tooMany))

console.log('3. 工位还回 → 库房在库数跟着回 + 排队兑现')
const fulfilled = await workshop.returnVolumes('wo_01', ['vol_0101'])
check('还回 1 册，兑现 1 条排队（chk_02 要 2 册）', fulfilled === 1, `fulfilled=${fulfilled}`)
check('函甲-01 在库回到 0（2 进 2 出）', warehouse.caseById('case_01')?.inStockCount === 0)
check('wo_01 已还齐', workshop.orderById('wo_01')?.state === 'closed')
const newOrder = workshop.orders.find((o) => o.checkoutId === 'chk_02')
check('chk_02 兑现并开出新工单（领 2 册）', !!newOrder && newOrder.volumeIds.length === 2)
check('chk_02 状态已出库', warehouse.requests.find((r) => r.id === 'chk_02')?.state === 'fulfilled')

console.log('4. 对账与重报')
for (const cs of warehouse.cases) {
  const holding = workshop.orders
    .filter((o) => o.caseId === cs.id)
    .flatMap((o) => holdingVolumeIds(o)).length
  const out = borrowedCount(cs)
  console.log(`  ${cs.caseNo}: 库房借出 ${out} / 工位在修 ${holding}`)
}
const case01After = warehouse.caseById('case_01')!
const holding01 = workshop.orders.filter((o) => o.caseId === 'case_01').flatMap((o) => holdingVolumeIds(o)).length
check('函甲-01 两账相平', borrowedCount(case01After) === holding01)
// 库房盘库修正制造差异 → 重报只留痕不改账
await warehouse.updateCase('case_03', { inStockCount: 0 })
check('盘库后函乙-01 库房借出 1', borrowedCount(warehouse.caseById('case_03')!) === 1)
await warehouse.reportRecon({ caseId: 'case_03', warehouseOut: 1, workshopHolding: 0, volumeNos: [], note: '工位按本侧重报' })
check('重报已留痕', warehouse.reports.length === 1 && warehouse.reports[0].caseId === 'case_03')
check('重报后库房账原样留着（在库仍 0）', warehouse.caseById('case_03')?.inStockCount === 0)

console.log('5. 旧版备份导入 → 按函现有册数回填历史格位')
const books = await db.books.toArray()
const volumes = await db.volumes.toArray()
await importSnapshot({
  app: 'gbbookrestore',
  schemaVersion: 2,
  exportedAt: new Date().toISOString(),
  books,
  volumes,
  leaves: [],
  papers: [],
  repairOrders: [],
  bindings: []
})
await warehouse.loadAll()
const legacy = await db.caseShelves.toArray()
check('回填函数 = 古籍数', legacy.length === books.length, `legacy=${legacy.length}`)
check(
  '每函格位容量 = 该古籍现有册数',
  legacy.every((cs) => cs.slotCapacity === volumes.filter((v) => v.bookId === cs.bookId).length)
)
check('回填后在库数 = 容量（全部视为在库）', legacy.every((cs) => cs.inStockCount === cs.slotCapacity))
const direct = buildLegacyCaseShelves(books, volumes)
check('buildLegacyCaseShelves 幂等可用', direct.length === books.length)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
