/**
 * useReconcile：库房与修复室两本账的对账逻辑
 *
 * 两边各记各的：
 * - 库房（StorageCase）记架位、格位容量、当前在库册数；
 * - 修复室（RepairTicket）记领了哪几册、拆下多少书叶、修好还回几册。
 *
 * 对账口径（按册数）：
 *   格位容量 = 在库册数 + 修复室未还回（在修 + 候位）册数
 * 对不上的函逐条摆出函号与册号；处理原则是工位按本侧重报工单，
 * 库房那份原样留着，本 hook 只负责算账与摆册号，不替任何一方改数。
 */
import { computed } from 'vue'
import type { StorageCase } from '@/types/storageCase'
import type { RepairTicket } from '@/types/repairTicket'
import { isTicketActive } from '@/types/repairTicket'

export interface ReconcileVolumeRef {
  volumeId: string
  /** 册号展示文本，如「第 2 册」 */
  label: string
}

export interface CaseReconcileDetail {
  volumeId: string
  /** 册号展示文本 */
  volumeLabel: string
  /** 库房是否认为该册在外：false 在架 / true 在外 / null 库房只记数无法逐册指认 */
  warehouseOut: boolean | null
  /** 修复室是否有未还回工单（含候位） */
  workshopOut: boolean
  /** ticket-extra：工单多记；ticket-missing：有册在外但缺工单 */
  kind: 'ticket-extra' | 'ticket-missing'
}

export interface CaseReconcileItem {
  caseRecord: StorageCase
  /** 库房口径：容量 - 在库 = 应有在外册数 */
  expectedOut: number
  /** 修复室口径：未还回（在修 + 候位）工单数 */
  actualOut: number
  /** 差额：正 = 工单多记（领了库房没出），负 = 工单少记（册在外但没单） */
  diff: number
  matched: boolean
  /** 对不上时摆出的函内册号明细 */
  details: CaseReconcileDetail[]
}

export interface ReconcileSummary {
  total: number
  matched: number
  mismatched: number
}

export interface ReconcileResolvers {
  /** 取一册的册号展示文本 */
  volumeLabelOf: (volumeId: string) => string
  /** 取一函在编的全部册（用于工单少记时摆出待核对册号） */
  volumesOfCase: (caseRecord: StorageCase) => ReconcileVolumeRef[]
}

export function useReconcile(
  cases: () => StorageCase[],
  tickets: () => RepairTicket[],
  resolvers: ReconcileResolvers
) {
  /** 修复室账：函 → 未还回工单（在修 + 候位） */
  const activeTicketsByCase = computed(() => {
    const map = new Map<string, RepairTicket[]>()
    for (const ticket of tickets()) {
      if (!isTicketActive(ticket)) continue
      const list = map.get(ticket.caseId) ?? []
      list.push(ticket)
      map.set(ticket.caseId, list)
    }
    return map
  })

  const reconciliations = computed<CaseReconcileItem[]>(() =>
    cases().map((caseRecord) => {
      const activeTickets = activeTicketsByCase.value.get(caseRecord.id) ?? []
      const expectedOut = Math.max(0, caseRecord.capacity - caseRecord.onShelfCount)
      const actualOut = activeTickets.length
      const diff = actualOut - expectedOut
      const details: CaseReconcileDetail[] = []

      if (diff > 0) {
        // 工单多记：修复室有单但库房格位已占满 → 摆出多出的册号，请工位重报
        activeTickets.slice(expectedOut).forEach((ticket) => {
          details.push({
            volumeId: ticket.volumeId,
            volumeLabel: resolvers.volumeLabelOf(ticket.volumeId),
            warehouseOut: false,
            workshopOut: true,
            kind: 'ticket-extra'
          })
        })
      } else if (diff < 0) {
        // 工单少记：库房认为有册在外，修复室却没有未还工单。
        // 库房那份只记册数、指认不到具体册号，摆出函内「没有未还工单」的在册册号供工位逐册核对。
        const accounted = new Set(activeTickets.map((ticket) => ticket.volumeId))
        resolvers
          .volumesOfCase(caseRecord)
          .filter((volume) => !accounted.has(volume.volumeId))
          .forEach((volume) => {
            details.push({
              volumeId: volume.volumeId,
              volumeLabel: volume.label,
              warehouseOut: null,
              workshopOut: false,
              kind: 'ticket-missing'
            })
          })
      }

      return { caseRecord, expectedOut, actualOut, diff, matched: diff === 0, details }
    })
  )

  const mismatches = computed<CaseReconcileItem[]>(() => reconciliations.value.filter((item) => !item.matched))

  const summary = computed<ReconcileSummary>(() => ({
    total: reconciliations.value.length,
    matched: reconciliations.value.filter((item) => item.matched).length,
    mismatched: mismatches.value.length
  }))

  return { reconciliations, mismatches, summary }
}
