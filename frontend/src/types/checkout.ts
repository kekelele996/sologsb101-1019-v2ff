/**
 * 出库请求（CheckoutRequest）数据模型
 * 修复室领册出库：在库够就立即出库并开立工单；
 * 容量放满（在库不足）就排队，等别的册还回腾格后按提交先后兑现。
 */

/** 出库状态：排队中 / 已出库 / 已取消 */
export type CheckoutState = 'queued' | 'fulfilled' | 'cancelled';

export interface CheckoutRequest {
  id: string;
  /** 申请出库的函 id */
  caseId: string;
  /** 申请领取册数 */
  count: number;
  /** 当前状态 */
  state: CheckoutState;
  /** 兑现后生成的工单 id */
  workOrderId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type CheckoutDraft = Omit<CheckoutRequest, 'id' | 'createdAt' | 'updatedAt'>;

export const CHECKOUT_STATE_LABEL: Record<CheckoutState, string> = {
  queued: '排队中',
  fulfilled: '已出库',
  cancelled: '已取消',
};

export const CHECKOUT_STATE_COLOR: Record<CheckoutState, string> = {
  queued: '#d68910',
  fulfilled: '#1e8449',
  cancelled: '#8c8c8c',
};
