/**
 * 函（StorageCase）数据模型 —— 库房那本账
 * 书库的册按函上架，库房在函上记三件事：
 * - shelfNo 架位：函摆在哪个格；
 * - capacity 格位容量：这一函最多放几册；
 * - onShelfCount 当前在库册数：此刻实际摆在架上的册数。
 *
 * 出库（修复室领书）会把册从架上取走；满格（在库 + 在外 = 容量）时
 * 再领就只能排队（waitQueue），等别的册修好还回腾出格位，FIFO 放出。
 */

/** 排队中的出库领书请求（满格时在此候位） */
export interface CaseQueueItem {
  /** 对应候位工单 id（RepairTicket.id） */
  ticketId: string
  /** 请求的册 id（Volume.id） */
  volumeId: string
  /** 领书工位（修复师 / 台案） */
  station: string
  /** 入队时间戳，决定 FIFO 先后 */
  queuedAt: number
}

export interface StorageCase {
  id: string
  /** 函号：业务编号（一部古籍通常一函） */
  caseNo: string
  /** 所属古籍 id（Book.id） */
  bookId: string
  /** 架位，如 甲库·三排·二格；旧数据升级回填时留空，标记为待补编 */
  shelfNo: string
  /** 格位容量：这一函最多容纳的册数 */
  capacity: number
  /** 当前在库册数（架上实摆的册数） */
  onShelfCount: number
  /** 满格时排队等候领出的出库请求 */
  waitQueue: CaseQueueItem[]
  /** 历史回填：v2→v3 升级时按函现有册数回填的容量标记为 true */
  historicalBackfill: boolean
  createdAt: number
  updatedAt: number
}

export type StorageCaseDraft = Omit<StorageCase, 'id' | 'createdAt' | 'updatedAt'>;

export function createEmptyCaseDraft(bookId: string, caseNo = ''): StorageCaseDraft {
  return {
    caseNo,
    bookId,
    shelfNo: '',
    capacity: 0,
    onShelfCount: 0,
    waitQueue: [],
    historicalBackfill: false
  }
}

/** 在库册数为 0 即格位全被在外册占满；满格后新领只能排队 */
export function isCaseFull(record: Pick<StorageCase, 'onShelfCount'>): boolean {
  return record.onShelfCount <= 0
}

/** 已被领出（占格、尚未还回）的册数 = 容量 - 在库；候位单不占格 */
export function lentCountOf(record: Pick<StorageCase, 'capacity' | 'onShelfCount'>): number {
  return record.capacity - record.onShelfCount
}

/** 候位排队册数（满格时积压的领书请求） */
export function waitingCountOf(record: Pick<StorageCase, 'waitQueue'>): number {
  return record.waitQueue.length
}
