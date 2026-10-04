/**
 * 对账重报（ReconReport）数据模型
 * 两边按册数对账，对不上就把函号和册号摆出来；
 * 工位按本侧重报留痕，库房函上的账原样留着不改。
 */

export interface ReconReport {
  id: string;
  /** 差异函 id */
  caseId: string;
  /** 库房账借出数（对账时点快照） */
  warehouseOut: number;
  /** 修复室账在修数（对账时点快照） */
  workshopHolding: number;
  /** 差异涉及册号 */
  volumeNos: number[];
  /** 重报说明 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type ReconReportDraft = Omit<ReconReport, 'id' | 'createdAt' | 'updatedAt'>;
