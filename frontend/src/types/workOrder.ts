/**
 * 修复工单（WorkOrder）数据模型 —— 修复室那本账
 * 按册开工单：记领了哪几册、拆下多少书叶、修好还回几册；
 * 工位把册还回，库房函上的在库数才跟着回。
 */

/** 工单状态：在修 / 部分还回 / 已还齐 */
export type WorkOrderState = 'open' | 'partial' | 'closed';

export interface WorkOrder {
  id: string;
  /** 工单号，如「修字 001」 */
  orderNo: string;
  /** 所属函 id */
  caseId: string;
  /** 领了哪几册（册次 id 列表） */
  volumeIds: string[];
  /** 拆下书叶数 */
  removedLeafCount: number;
  /** 修好还回的册（册次 id 列表），长度即还回册数 */
  returnedVolumeIds: string[];
  /** 当前状态 */
  state: WorkOrderState;
  /** 来源出库请求 id */
  checkoutId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkOrderDraft = Omit<WorkOrder, 'id' | 'createdAt' | 'updatedAt'>;

export const WORK_ORDER_STATE_LABEL: Record<WorkOrderState, string> = {
  open: '在修',
  partial: '部分还回',
  closed: '已还齐',
};

export const WORK_ORDER_STATE_COLOR: Record<WorkOrderState, string> = {
  open: '#d68910',
  partial: '#3a6ea5',
  closed: '#1e8449',
};

/** 工位手上还在修的册（领了未还） */
export function holdingVolumeIds(order: Pick<WorkOrder, 'volumeIds' | 'returnedVolumeIds'>): string[] {
  return order.volumeIds.filter((id) => !order.returnedVolumeIds.includes(id));
}

/** 修好还回册数 */
export function returnedCount(order: Pick<WorkOrder, 'returnedVolumeIds'>): number {
  return order.returnedVolumeIds.length;
}
