/**
 * 库房账 store（Pinia setup store）
 * 函台账（架位 / 格位容量 / 当前在库册数）、出库排队与还回腾格兑现、对账重报留痕；
 * 库房这本账只由库房侧动作改写，对账重报不动它。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import { borrowedCount, type CaseShelf, type CaseShelfDraft } from '@/types/caseShelf'
import type { CheckoutRequest, CheckoutState } from '@/types/checkout'
import { holdingVolumeIds, type WorkOrder } from '@/types/workOrder'
import type { ReconReport, ReconReportDraft } from '@/types/reconReport'

export const useWarehouseStore = defineStore('warehouse', () => {
  const cases = ref<CaseShelf[]>([])
  const requests = ref<CheckoutRequest[]>([])
  const reports = ref<ReconReport[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  /** 排队中的出库请求：按提交先后兑现 */
  const queuedRequests = computed<CheckoutRequest[]>(() =>
    requests.value.filter((row) => row.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)
  )

  const recentRequests = computed<CheckoutRequest[]>(() =>
    [...requests.value].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
  )

  const recentReports = computed<ReconReport[]>(() =>
    [...reports.value].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5)
  )

  const totalCapacity = computed<number>(() => cases.value.reduce((sum, row) => sum + row.slotCapacity, 0))
  const totalInStock = computed<number>(() => cases.value.reduce((sum, row) => sum + row.inStockCount, 0))
  const totalBorrowed = computed<number>(() => cases.value.reduce((sum, row) => sum + borrowedCount(row), 0))

  async function loadCases(): Promise<void> {
    const rows = await db.caseShelves.toArray()
    rows.sort((a, b) => a.caseNo.localeCompare(b.caseNo))
    cases.value = rows
  }

  async function loadRequests(): Promise<void> {
    requests.value = await db.checkoutRequests.toArray()
  }

  async function loadReports(): Promise<void> {
    reports.value = await db.reconReports.toArray()
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      await Promise.all([loadCases(), loadRequests(), loadReports()])
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '库房台账读取失败'
    } finally {
      loading.value = false
    }
  }

  function caseById(id: string): CaseShelf | undefined {
    return cases.value.find((row) => row.id === id)
  }

  /** 事务内可用：取该函当前在库（未被工位占用）的册，按册号升序 */
  async function pickInStockVolumeIds(caseId: string, count: number): Promise<string[]> {
    const cs = await db.caseShelves.get(caseId)
    if (!cs) return []
    const volumes = await db.volumes.where('bookId').equals(cs.bookId).toArray()
    const orders = await db.workOrders.where('caseId').equals(caseId).toArray()
    const holding = new Set(orders.flatMap((order) => holdingVolumeIds(order)))
    return volumes
      .filter((volume) => !holding.has(volume.id))
      .sort((a, b) => a.volumeNo - b.volumeNo)
      .slice(0, count)
      .map((volume) => volume.id)
  }

  async function nextWorkOrderNo(): Promise<string> {
    const count = await db.workOrders.count()
    return `修字 ${String(count + 1).padStart(3, '0')}`
  }

  /** 事务内开立工单（出库兑现时调用），返回工单 id */
  async function createWorkOrderTx(caseId: string, volumeIds: string[], checkoutId: string, now: number): Promise<string> {
    const id = createId('wo')
    const row: WorkOrder = {
      id,
      orderNo: await nextWorkOrderNo(),
      caseId,
      volumeIds,
      removedLeafCount: 0,
      returnedVolumeIds: [],
      state: 'open',
      checkoutId,
      createdAt: now,
      updatedAt: now
    }
    await db.workOrders.put(row)
    return id
  }

  /**
   * 领册出库：在库够就立即出库并开立工单；
   * 容量放满（在库不足）就排队，等别的册还回腾格。
   */
  async function requestCheckout(caseId: string, count: number): Promise<CheckoutState> {
    const cs = cases.value.find((row) => row.id === caseId)
    if (!cs) throw new Error('函不存在或已删除')
    if (!Number.isInteger(count) || count < 1) throw new Error('领取册数至少为 1')
    if (count > cs.slotCapacity) throw new Error(`领取册数不能超过格位容量（${cs.slotCapacity}）`)
    const now = Date.now()
    if (cs.inStockCount < count) {
      const row: CheckoutRequest = {
        id: createId('chk'),
        caseId,
        count,
        state: 'queued',
        workOrderId: null,
        createdAt: now,
        updatedAt: now
      }
      await db.checkoutRequests.put(row)
      await loadRequests()
      return 'queued'
    }
    await db.transaction('rw', [db.caseShelves, db.checkoutRequests, db.workOrders, db.volumes], async () => {
      const volumeIds = await pickInStockVolumeIds(caseId, count)
      const requestId = createId('chk')
      const workOrderId = await createWorkOrderTx(caseId, volumeIds, requestId, now)
      const row: CheckoutRequest = {
        id: requestId,
        caseId,
        count,
        state: 'fulfilled',
        workOrderId,
        createdAt: now,
        updatedAt: now
      }
      await db.checkoutRequests.put(row)
      await db.caseShelves.update(caseId, { inStockCount: cs.inStockCount - count, updatedAt: now })
    })
    await Promise.all([loadCases(), loadRequests()])
    return 'fulfilled'
  }

  /**
   * 工位把册还回：库房在库数跟着回（不超格位容量），
   * 腾出格位后按提交先后兑现排队请求，返回兑现条数。
   */
  async function restockAndFulfill(caseId: string, count: number): Promise<number> {
    let fulfilled = 0
    await db.transaction('rw', [db.caseShelves, db.checkoutRequests, db.workOrders, db.volumes], async () => {
      const cs = await db.caseShelves.get(caseId)
      if (!cs) return
      const now = Date.now()
      let stock = Math.min(cs.slotCapacity, cs.inStockCount + count)
      const queued = (await db.checkoutRequests.where('caseId').equals(caseId).toArray())
        .filter((row) => row.state === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt)
      for (const request of queued) {
        if (request.count > stock) break
        const volumeIds = await pickInStockVolumeIds(caseId, request.count)
        const workOrderId = await createWorkOrderTx(caseId, volumeIds, request.id, now)
        await db.checkoutRequests.update(request.id, { state: 'fulfilled', workOrderId, updatedAt: now } as never)
        stock -= request.count
        fulfilled += 1
      }
      await db.caseShelves.update(caseId, { inStockCount: stock, updatedAt: now })
    })
    await Promise.all([loadCases(), loadRequests()])
    return fulfilled
  }

  async function cancelRequest(id: string): Promise<void> {
    await db.checkoutRequests.update(id, { state: 'cancelled', updatedAt: Date.now() } as never)
    await loadRequests()
  }

  async function createCase(draft: CaseShelfDraft): Promise<CaseShelf> {
    const now = Date.now()
    const capacity = Math.max(0, Math.floor(draft.slotCapacity))
    const row: CaseShelf = {
      ...draft,
      slotCapacity: capacity,
      inStockCount: Math.min(capacity, Math.max(0, Math.floor(draft.inStockCount))),
      id: createId('case'),
      createdAt: now,
      updatedAt: now
    }
    await db.caseShelves.put(row)
    await loadCases()
    return row
  }

  /** 库房盘库修正：架位 / 格位容量 / 在库册数都由库房自己记，在库数钳制在容量内 */
  async function updateCase(id: string, patch: Partial<CaseShelf>): Promise<void> {
    const current = cases.value.find((row) => row.id === id)
    const next: Partial<CaseShelf> = { ...patch }
    if (current) {
      const capacity =
        typeof patch.slotCapacity === 'number' ? Math.max(0, Math.floor(patch.slotCapacity)) : current.slotCapacity
      next.slotCapacity = capacity
      const stock = typeof patch.inStockCount === 'number' ? patch.inStockCount : current.inStockCount
      next.inStockCount = Math.min(capacity, Math.max(0, Math.floor(stock)))
    }
    await db.caseShelves.update(id, { ...next, updatedAt: Date.now() } as never)
    await loadCases()
  }

  /** 删除函并级联清理其出库请求 / 工单 / 重报；有未还齐工单或排队请求时拒绝 */
  async function removeCase(id: string): Promise<string> {
    const orders = await db.workOrders.where('caseId').equals(id).toArray()
    if (orders.some((order) => order.state !== 'closed')) return '该函还有未还齐的工单，不能删除'
    const related = await db.checkoutRequests.where('caseId').equals(id).toArray()
    if (related.some((row) => row.state === 'queued')) return '该函还有排队中的出库请求，不能删除'
    await db.transaction('rw', [db.caseShelves, db.checkoutRequests, db.workOrders, db.reconReports], async () => {
      await db.checkoutRequests.where('caseId').equals(id).delete()
      await db.workOrders.where('caseId').equals(id).delete()
      await db.reconReports.where('caseId').equals(id).delete()
      await db.caseShelves.delete(id)
    })
    await Promise.all([loadCases(), loadRequests(), loadReports()])
    return ''
  }

  /** 对不上时工位按本侧重报：只留痕，库房函上的账原样留着 */
  async function reportRecon(draft: ReconReportDraft): Promise<void> {
    const now = Date.now()
    const row: ReconReport = { ...draft, id: createId('recon'), createdAt: now, updatedAt: now }
    await db.reconReports.put(row)
    await loadReports()
  }

  return {
    cases,
    requests,
    reports,
    loading,
    ready,
    error,
    queuedRequests,
    recentRequests,
    recentReports,
    totalCapacity,
    totalInStock,
    totalBorrowed,
    loadAll,
    loadCases,
    loadRequests,
    loadReports,
    caseById,
    requestCheckout,
    restockAndFulfill,
    cancelRequest,
    createCase,
    updateCase,
    removeCase,
    reportRecon
  }
})
