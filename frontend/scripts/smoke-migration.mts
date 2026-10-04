/**
 * v2 → v3 升级迁移验证：
 * 旧库只有 6 张表、函还没记格位容量；升级到 v3 后应按函现有的册数回填一份历史格位。
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'

const store = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear()
}

// 1. 以旧版 v2 结构建库并写入历史数据
const legacy = new Dexie('gbbookrestore')
legacy
  .version(1)
  .stores({
    books: 'id, title, era, level, updatedAt',
    volumes: 'id, bookId, volumeNo, state, updatedAt',
    leaves: 'id, volumeId, leafNo, damageType, state, updatedAt',
    papers: 'id, leafId, paperType, deltaE, updatedAt',
    repairOrders: 'id, leafId, seq, name, state, updatedAt',
    bindings: 'id, volumeId, verdict, finishDate, updatedAt'
  })
legacy
  .version(2)
  .stores({
    books: 'id, title, era, level, collectionNo, updatedAt',
    volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
    leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
    papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
    repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
    bindings: 'id, volumeId, method, verdict, finishDate, updatedAt'
  })
await legacy.open()
const now = Date.now()
await legacy.table('books').bulkPut([
  { id: 'book_old1', title: '旧籍一', edition: '清刻本', era: '清', volumeCount: 3, collectionNo: 'GJ-1001', level: 'normal', createdAt: now, updatedAt: now },
  { id: 'book_old2', title: '旧籍二', edition: '明抄本', era: '明', volumeCount: 1, collectionNo: 'GJ-1002', level: 'first', createdAt: now, updatedAt: now }
])
await legacy.table('volumes').bulkPut([
  { id: 'vol_o1', bookId: 'book_old1', volumeNo: 1, leafCount: 10, bindingType: 'thread', state: 'pending', createdAt: now, updatedAt: now },
  { id: 'vol_o2', bookId: 'book_old1', volumeNo: 2, leafCount: 12, bindingType: 'thread', state: 'pending', createdAt: now, updatedAt: now },
  { id: 'vol_o3', bookId: 'book_old1', volumeNo: 3, leafCount: 8, bindingType: 'thread', state: 'pending', createdAt: now, updatedAt: now },
  { id: 'vol_o4', bookId: 'book_old2', volumeNo: 1, leafCount: 20, bindingType: 'butterfly', state: 'archived', createdAt: now, updatedAt: now }
])
legacy.close()

// 2. 用当前 v3 结构重新打开，触发 upgrade
const { db, DB_VERSION } = await import('../src/utils/db')
await db.open()

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

check('升级后版本为 v3', db.verno === 3 && DB_VERSION === 3, `verno=${db.verno}`)
const cases = await db.caseShelves.toArray()
check('每部古籍回填一函', cases.length === 2, `cases=${cases.length}`)
const c1 = cases.find((c) => c.bookId === 'book_old1')
const c2 = cases.find((c) => c.bookId === 'book_old2')
check('旧籍一函格位容量回填为 3（现有册数）', c1?.slotCapacity === 3, `cap=${c1?.slotCapacity}`)
check('旧籍一函在库册数 3', c1?.inStockCount === 3)
check('旧籍二函格位容量回填为 1', c2?.slotCapacity === 1)
check('回填函架位标记为旧库未排架', cases.every((c) => c.shelfLocation === '旧库未排架'))
check('历史数据仍在', (await db.volumes.count()) === 4 && (await db.books.count()) === 2)

console.log(failures === 0 ? '\n迁移验证全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
