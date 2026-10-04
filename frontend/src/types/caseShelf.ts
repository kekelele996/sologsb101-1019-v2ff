/**
 * 函（CaseShelf）数据模型 —— 库房那本账
 * 库房在函上记架位、格位容量与当前在库册数；
 * 修复室领走册后在库数扣减，工位把册还回时在库数才跟着回。
 */

export interface CaseShelf {
  id: string;
  /** 函号，如「函甲-01」 */
  caseNo: string;
  /** 所属古籍 id（一函装一部书的若干册） */
  bookId: string;
  /** 架位，如「甲字架 3 层 2 格」 */
  shelfLocation: string;
  /** 格位容量：该函最多容纳的册数 */
  slotCapacity: number;
  /** 当前在库册数 */
  inStockCount: number;
  createdAt: number;
  updatedAt: number;
}

export type CaseShelfDraft = Omit<CaseShelf, 'id' | 'createdAt' | 'updatedAt'>;

/** 借出数 = 格位容量 − 在库册数（库房账口径） */
export function borrowedCount(row: Pick<CaseShelf, 'slotCapacity' | 'inStockCount'>): number {
  return Math.max(0, row.slotCapacity - row.inStockCount);
}

/** 在库状态：满函在库 / 部分借出 / 全部借出（容量放满，再领只能排队） */
export type CaseStockState = 'full' | 'partial' | 'drained';

export function caseStockState(row: Pick<CaseShelf, 'slotCapacity' | 'inStockCount'>): CaseStockState {
  if (row.inStockCount <= 0) return 'drained';
  if (row.inStockCount >= row.slotCapacity) return 'full';
  return 'partial';
}

export const CASE_STOCK_STATE_LABEL: Record<CaseStockState, string> = {
  full: '满函在库',
  partial: '部分借出',
  drained: '全部借出',
};

export const CASE_STOCK_STATE_COLOR: Record<CaseStockState, string> = {
  full: '#1e8449',
  partial: '#d68910',
  drained: '#b03a2e',
};

export function createEmptyCaseShelfDraft(bookId: string, slotCapacity = 1): CaseShelfDraft {
  return {
    caseNo: '',
    bookId,
    shelfLocation: '',
    slotCapacity,
    inStockCount: slotCapacity,
  };
}
