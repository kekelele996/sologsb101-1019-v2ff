/**
 * 库房 × 修复室往来 store（Pinia setup store）
 *
 * 两边各记一本：
 * - 库房账 storageCases：函号、架位、格位容量、当前在库册数；
 * - 修复室账 repairTickets：按册开工单，记领了哪几册、拆下多少书叶、修好还回几册。
 *
 * 联动规则：
 * - 领书（出库）：格位放满（容量 = 在库 + 在外）就不开「在修」单，
 *   工单记为「候位」并进函的排队队列，等别的册还回腾格，按 FIFO 放出；
 * - 还回：只走「工位还册 → 工单记还回」这一条路，库房那份在库数才跟着回涨，
 *   涨出空格后自动把队首候位单放出；
 * - 对账不符时工位只准动自己这本（重报 / 补报 / 撤单），库房那份原样留着。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import type { StorageCase } from '@/types/storageCase'
import { isCaseFull } from '@/types/storageCase'
import type { RepairTicket, RepairTicketDraft } from '@/types/repairTicket'

export interface LendDraft {
  volumeId: string
  bookId: string
  caseId?: string
  station: string
  detachedLeaves: number
  lentDate: string
}

export type RestateTicketPatch = Partial<
  Pick<RepairTicket, 'station' | 'detachedLeaves' | 'lentDate' | 'returnedCount' | 'returnedDate' | 'status'>
>

export const useStorageStore = defineStore('storage', () => {
  const cases = ref<StorageCase[]>([])
  const tickets = ref<RepairTicket[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      const [caseRows, ticketRows] = await Promise.all([db.storageCases.toArray(), db.repairTickets.toArray()])
      caseRows.sort((a, b) => a.caseNo.localeCompare(b.caseNo, 'zh-Hans-CN'))
      ticketRows.sort((a, b) => b.updatedAt - a.updatedAt)
      cases.value = caseRows
      tickets.value = ticketRows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '库房往来账读取失败'
    } finally {
      loading.value = false
    }
  }

  function caseById(id: string): StorageCase | undefined {
    return cases.value.find((item) => item.id === id)
  }

  function caseOfBook(bookId: string): StorageCase | undefined {
    return cases.value.find((item) => item.bookId === bookId)
  }

  function ticketById(id: string): RepairTicket | undefined {
    return tickets.value.find((item) => item.id === id)
  }

  function ticketsOfCase(caseId: string): RepairTicket[] {
    return tickets.value
      .filter((ticket) => ticket.caseId === caseId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  const totalOnShelf = computed(() => cases.value.reduce((sum, item) => sum + item.onShelfCount, 0))
  /** 候位册数：各函排队队列长度之和（与候位工单数一致） */
  const waitingTicketCount = computed(() => cases.value.reduce((sum, item) => sum + item.waitQueue.length, 0))
  const activeTicketCount = computed(() => tickets.value.filter((ticket) => ticket.status !== 'returned').length)
  const outTicketCount = computed(() => tickets.value.filter((ticket) => ticket.status === 'out').length)

  /* ------------------------------- 库房账 ------------------------------- */

  async function createCase(draft: Omit<StorageCase, 'id' | 'createdAt' | 'updatedAt'>): Promise<StorageCase> {
    if (caseOfBook(draft.bookId)) throw new Error('该古籍已有函档，一部古籍一函')
    const now = Date.now()
    const row: StorageCase = { ...draft, id: createId('case'), createdAt: now, updatedAt: now }
    await db.storageCases.put(row)
    await loadAll()
    return row
  }

  async function updateCase(id: string, patch: Partial<StorageCase>): Promise<void> {
    const current = caseById(id)
    if (!current) return
    const next = { ...current, ...patch }
    if (next.capacity < 0 || next.onShelfCount < 0) throw new Error('容量与在库册数不能为负')
    if (next.onShelfCount > next.capacity) throw new Error('在库册数不能超过格位容量')
    await db.storageCases.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
  }

  async function removeCase(id: string): Promise<void> {
    await db.transaction('rw', [db.storageCases, db.repairTickets], async () => {
      await db.repairTickets.where('caseId').equals(id).delete()
      await db.storageCases.delete(id)
    })
    await loadAll()
  }

  /* ------------------------------ 领书 / 还回 ------------------------------ */

  /**
   * 工位领书出库。
   * 满格 → 工单「候位」并入队，库房在库数不动；
   * 有空位 → 工单「在修」，库房在库数 -1。
   * @returns 工单落定状态
   */
  async function lendVolume(draft: LendDraft): Promise<RepairTicket['status']> {
    const caseId = draft.caseId ?? caseOfBook(draft.bookId)?.id
    if (!caseId) throw new Error('该函尚未在库房建档，先登记函档再领书')
    let status: RepairTicket['status'] = 'out'
    await db.transaction('rw', [db.storageCases, db.repairTickets], async () => {
      const caseRecord = await db.storageCases.get(caseId)
      if (!caseRecord) throw new Error('函档不存在')
      const duplicated = (
        await db.repairTickets.where('volumeId').equals(draft.volumeId).toArray()
      ).some((ticket) => ticket.caseId === caseId && ticket.status !== 'returned')
      if (duplicated) throw new Error('该册已有未还回的工单，不能重复领书')

      const now = Date.now()
      const ticketId = createId('ticket')
      status = isCaseFull(caseRecord) ? 'waiting' : 'out'
      const ticket: RepairTicket = {
        id: ticketId,
        volumeId: draft.volumeId,
        caseId,
        station: draft.station.trim(),
        lentDate: draft.lentDate,
        detachedLeaves: Math.max(0, Math.floor(draft.detachedLeaves)),
        returnedCount: 0,
        returnedDate: '',
        restatedAt: null,
        status,
        createdAt: now,
        updatedAt: now
      }
      await db.repairTickets.put(ticket)

      if (status === 'waiting') {
        // 容量放满：排队等别的册还回腾格
        caseRecord.waitQueue.push({ ticketId, volumeId: draft.volumeId, station: draft.station.trim(), queuedAt: now })
      } else {
        caseRecord.onShelfCount -= 1
      }
      caseRecord.updatedAt = now
      await db.storageCases.put(caseRecord)
    })
    await loadAll()
    return status
  }

  /**
   * 工位把册还回：工单记「已还回」，库房在库数 +1；
   * 腾出空格后按 FIFO 放出候位工单，每放出一册在库数再 -1。
   * @returns 本次连带放出的候位工单
   */
  async function returnVolume(ticketId: string, returnedDate: string): Promise<RepairTicket[]> {
    const released: RepairTicket[] = []
    await db.transaction('rw', [db.repairTickets, db.storageCases], async () => {
      const ticket = await db.repairTickets.get(ticketId)
      if (!ticket) throw new Error('工单不存在')
      if (ticket.status !== 'out') throw new Error(ticket.status === 'waiting' ? '该册还在候位，无需还回' : '该工单已经还回')
      const caseRecord = await db.storageCases.get(ticket.caseId)
      if (!caseRecord) throw new Error('函档不存在')

      const now = Date.now()
      ticket.status = 'returned'
      ticket.returnedCount = 1
      ticket.returnedDate = returnedDate
      ticket.updatedAt = now
      await db.repairTickets.put(ticket)

      // 库房那份在库数跟着回涨
      caseRecord.onShelfCount = Math.min(caseRecord.capacity, caseRecord.onShelfCount + 1)
      caseRecord.updatedAt = now

      // 空格放出队首候位单
      while (!isCaseFull(caseRecord) && caseRecord.waitQueue.length > 0) {
        const queued = caseRecord.waitQueue.shift() as NonNullable<StorageCase['waitQueue'][number]>
        const waitingTicket = await db.repairTickets.get(queued.ticketId)
        if (!waitingTicket || waitingTicket.status !== 'waiting') continue
        waitingTicket.status = 'out'
        waitingTicket.updatedAt = now
        await db.repairTickets.put(waitingTicket)
        caseRecord.onShelfCount -= 1
        released.push(waitingTicket)
      }
      await db.storageCases.put(caseRecord)
    })
    await loadAll()
    return released
  }

  /** 候位工单撤单：出队并删单，库房在库数本就没动 */
  async function cancelWaiting(ticketId: string): Promise<void> {
    await db.transaction('rw', [db.repairTickets, db.storageCases], async () => {
      const ticket = await db.repairTickets.get(ticketId)
      if (!ticket) return
      if (ticket.status !== 'waiting') throw new Error('只有候位中的工单可以撤回')
      const caseRecord = await db.storageCases.get(ticket.caseId)
      if (caseRecord) {
        caseRecord.waitQueue = caseRecord.waitQueue.filter((item) => item.ticketId !== ticketId)
        caseRecord.updatedAt = Date.now()
        await db.storageCases.put(caseRecord)
      }
      await db.repairTickets.delete(ticketId)
    })
    await loadAll()
  }

  /* --------------------------- 对账不符：按本侧重报 --------------------------- */

  /**
   * 工位按本侧重报工单：只改修复室这本账（含状态 / 还回数），
   * 记 restatedAt，库房那份在库数与队列原样留着。
   */
  async function restateTicket(ticketId: string, patch: RestateTicketPatch): Promise<void> {
    const ticket = ticketById(ticketId)
    if (!ticket) throw new Error('工单不存在')
    const next: Partial<RepairTicket> = { ...patch, restatedAt: Date.now(), updatedAt: Date.now() }
    if (next.status === 'returned') {
      next.returnedCount = Math.max(1, next.returnedCount ?? ticket.returnedCount ?? 1)
      if (!next.returnedDate) next.returnedDate = ticket.returnedDate || new Date().toISOString().slice(0, 10)
    }
    await db.repairTickets.update(ticketId, next as never)
    await loadAll()
  }

  /** 工单少记（册在外但没单）：工位补报一册，同样不碰库房账 */
  async function restateCreateTicket(draft: RepairTicketDraft): Promise<RepairTicket> {
    const now = Date.now()
    const row: RepairTicket = {
      ...draft,
      detachedLeaves: Math.max(0, Math.floor(draft.detachedLeaves)),
      id: createId('ticket'),
      restatedAt: now,
      createdAt: now,
      updatedAt: now
    }
    await db.repairTickets.put(row)
    await loadAll()
    return row
  }

  /** 工单多记且确认错领：工位撤回这本工单，库房账不动，对账重新计算 */
  async function restateRemoveTicket(ticketId: string): Promise<void> {
    const ticket = ticketById(ticketId)
    if (!ticket) return
    if (ticket.status === 'waiting') {
      await cancelWaiting(ticketId)
      return
    }
    await db.repairTickets.delete(ticketId)
    await loadAll()
  }

  return {
    cases,
    tickets,
    loading,
    ready,
    error,
    totalOnShelf,
    activeTicketCount,
    waitingTicketCount,
    outTicketCount,
    loadAll,
    caseById,
    caseOfBook,
    ticketById,
    ticketsOfCase,
    createCase,
    updateCase,
    removeCase,
    lendVolume,
    returnVolume,
    cancelWaiting,
    restateTicket,
    restateCreateTicket,
    restateRemoveTicket
  }
})
