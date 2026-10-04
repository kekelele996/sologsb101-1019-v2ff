/**
 * 修复室工单 store（Pinia setup store）
 * 工位那本账：按册记领了哪几册、拆下多少书叶、修好还回几册；
 * 工位把册还回时联动库房函上的在库数。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/utils/db'
import { holdingVolumeIds, type WorkOrder, type WorkOrderState } from '@/types/workOrder'
import { useWarehouseStore } from './warehouseStore'

export const useWorkshopStore = defineStore('workshop', () => {
  const orders = ref<WorkOrder[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  /** 未还齐的工单 */
  const openOrders = computed<WorkOrder[]>(() => orders.value.filter((order) => order.state !== 'closed'))

  /** 工位手上还在修的册数（领了未还） */
  const holdingCount = computed<number>(() =>
    orders.value.reduce((sum, order) => sum + holdingVolumeIds(order).length, 0)
  )

  const removedLeafTotal = computed<number>(() =>
    orders.value.reduce((sum, order) => sum + order.removedLeafCount, 0)
  )

  const returnedTotal = computed<number>(() =>
    orders.value.reduce((sum, order) => sum + order.returnedVolumeIds.length, 0)
  )

  async function loadOrders(): Promise<void> {
    loading.value = true
    try {
      const rows = await db.workOrders.toArray()
      rows.sort((a, b) => b.createdAt - a.createdAt)
      orders.value = rows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '工单读取失败'
    } finally {
      loading.value = false
    }
  }

  function orderById(id: string): WorkOrder | undefined {
    return orders.value.find((order) => order.id === id)
  }

  /** 登记拆下书叶数 */
  async function updateRemovedLeaves(id: string, removedLeafCount: number): Promise<void> {
    const count = Math.max(0, Math.floor(removedLeafCount))
    await db.workOrders.update(id, { removedLeafCount: count, updatedAt: Date.now() } as never)
    await loadOrders()
  }

  /**
   * 工位把册还回：工单记还回册，库房函上的在库数才跟着回；
   * 返回还回腾格后兑现的排队出库请求数。
   */
  async function returnVolumes(id: string, volumeIds: string[]): Promise<number> {
    const order = orders.value.find((row) => row.id === id)
    if (!order) return 0
    const returning = volumeIds.filter(
      (vid) => order.volumeIds.includes(vid) && !order.returnedVolumeIds.includes(vid)
    )
    if (returning.length === 0) return 0
    const returnedVolumeIds = [...order.returnedVolumeIds, ...returning]
    const state: WorkOrderState = returnedVolumeIds.length >= order.volumeIds.length ? 'closed' : 'partial'
    await db.workOrders.update(id, { returnedVolumeIds, state, updatedAt: Date.now() } as never)
    const warehouseStore = useWarehouseStore()
    const fulfilled = await warehouseStore.restockAndFulfill(order.caseId, returning.length)
    // 排队兑现可能开出新工单，库房联动完再刷一次工单台账
    await loadOrders()
    return fulfilled
  }

  /** 仅已还齐的工单可删除（在修工单删了两边账就对不上了） */
  async function removeOrder(id: string): Promise<void> {
    await db.workOrders.delete(id)
    await loadOrders()
  }

  return {
    orders,
    loading,
    ready,
    error,
    openOrders,
    holdingCount,
    removedLeafTotal,
    returnedTotal,
    loadOrders,
    orderById,
    updateRemovedLeaves,
    returnVolumes,
    removeOrder
  }
})
