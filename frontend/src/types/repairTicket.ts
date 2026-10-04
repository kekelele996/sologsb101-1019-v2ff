/**
 * 修复工单（RepairTicket）数据模型 —— 修复室那本账
 * 修复室按册开工单，逐册记：
 * - volumeId / caseId：领了哪一函的哪一册；
 * - detachedLeaves：拆下多少书叶；
 * - returnedCount：修好还回几册（一册还回即 1）。
 *
 * 工位把册还回，库房那份在库数才跟着回涨；库房并不直接改自己的账，
 * 两边按册数对账，对不上由工位按本侧重报工单，库房那份原样留着。
 */

/** 工单状态：候位（满格排队） / 领出在修 / 已还回 */
export type TicketStatus = 'waiting' | 'out' | 'returned';

export interface RepairTicket {
  id: string
  /** 册 id（Volume.id），一册一单 */
  volumeId: string
  /** 所属函 id（StorageCase.id） */
  caseId: string
  /** 领书工位（修复师 / 台案） */
  station: string
  /** 领书日期 yyyy-MM-dd */
  lentDate: string
  /** 拆下书叶数 */
  detachedLeaves: number
  /** 修好还回册数（0 未还 / 1 已还） */
  returnedCount: number
  /** 还回日期 yyyy-MM-dd，未还为空串 */
  returnedDate: string
  /** 工位最近一次按本侧重报的时间戳，未重报为 null */
  restatedAt: number | null
  status: TicketStatus
  createdAt: number
  updatedAt: number
}

export type RepairTicketDraft = Omit<RepairTicket, 'id' | 'createdAt' | 'updatedAt'>;

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  waiting: '候位中',
  out: '在修',
  returned: '已还回'
}

export const TICKET_STATUS_COLOR: Record<TicketStatus, string> = {
  waiting: '#8c6d1f',
  out: '#b03a2e',
  returned: '#1e8449'
}

export function createEmptyTicketDraft(volumeId: string, caseId: string, station: string): RepairTicketDraft {
  return {
    volumeId,
    caseId,
    station,
    lentDate: new Date().toISOString().slice(0, 10),
    detachedLeaves: 0,
    returnedCount: 0,
    returnedDate: '',
    restatedAt: null,
    status: 'waiting'
  }
}

/** 占用格位（在修未还）的工单计数 */
export function isTicketActive(ticket: Pick<RepairTicket, 'status'>): boolean {
  return ticket.status !== 'returned'
}

/** 工单已还回 */
export function isTicketReturned(ticket: Pick<RepairTicket, 'returnedCount' | 'status'>): boolean {
  return ticket.returnedCount > 0 || ticket.status === 'returned'
}
