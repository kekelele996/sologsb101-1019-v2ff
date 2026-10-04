<script setup lang="ts">
/**
 * /warehouse 库房架位台账（库房那本账）
 * 函上记架位、格位容量与当前在库册数；出库容量放满就排队等别的册还回腾格；
 * 与修复室工单按册数对账，对不上摆出函号册号，工位按本侧重报，库房账原样保留。
 * 消费 CaseShelf、CheckoutRequest、ReconReport；复用 <StatBadge>、<EmptyPanel>。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useBookStore } from '@/stores/bookStore'
import { useWarehouseStore } from '@/stores/warehouseStore'
import { useWorkshopStore } from '@/stores/workshopStore'
import {
  CASE_STOCK_STATE_COLOR,
  CASE_STOCK_STATE_LABEL,
  borrowedCount,
  caseStockState,
  createEmptyCaseShelfDraft,
  type CaseShelf
} from '@/types/caseShelf'
import { CHECKOUT_STATE_COLOR, CHECKOUT_STATE_LABEL } from '@/types/checkout'
import { holdingVolumeIds } from '@/types/workOrder'
import type { ReconReport } from '@/types/reconReport'

const bookStore = useBookStore()
const warehouseStore = useWarehouseStore()
const workshopStore = useWorkshopStore()

function bookTitle(bookId: string): string {
  return bookStore.bookById(bookId)?.title ?? '古籍已删除'
}

function caseNo(caseId: string): string {
  return warehouseStore.caseById(caseId)?.caseNo ?? '函已删除'
}

function volumeNoOf(volumeId: string): number {
  return bookStore.volumeById(volumeId)?.volumeNo ?? 0
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}

/* ----------------------------- 函台账 ----------------------------- */
const caseDialog = ref(false)
const caseEditing = ref<CaseShelf | null>(null)
const caseForm = reactive(createEmptyCaseShelfDraft('', 1))

const bookOptions = computed(() =>
  bookStore.books.map((book) => ({
    value: book.id,
    label: `《${book.title}》（现有 ${bookStore.volumesOfBook(book.id).length} 册）`
  }))
)

function openCaseCreate(): void {
  const first = bookOptions.value[0]
  if (!first) {
    ElMessage.warning('请先在古籍台账中登记古籍')
    return
  }
  caseEditing.value = null
  const count = bookStore.volumesOfBook(first.value).length
  Object.assign(caseForm, createEmptyCaseShelfDraft(first.value, Math.max(1, count)))
  caseForm.caseNo = `函-${String(warehouseStore.cases.length + 1).padStart(2, '0')}`
  caseDialog.value = true
}

function openCaseEdit(row: CaseShelf): void {
  caseEditing.value = row
  Object.assign(caseForm, {
    caseNo: row.caseNo,
    bookId: row.bookId,
    shelfLocation: row.shelfLocation,
    slotCapacity: row.slotCapacity,
    inStockCount: row.inStockCount
  })
  caseDialog.value = true
}

function onCaseBookChange(bookId: string): void {
  if (caseEditing.value) return
  const count = bookStore.volumesOfBook(bookId).length
  caseForm.slotCapacity = Math.max(1, count)
  caseForm.inStockCount = caseForm.slotCapacity
}

async function submitCase(): Promise<void> {
  if (!caseForm.bookId) {
    ElMessage.warning('请选择所属古籍')
    return
  }
  if (!caseForm.caseNo.trim()) {
    ElMessage.warning('请填写函号')
    return
  }
  if (caseEditing.value) {
    await warehouseStore.updateCase(caseEditing.value.id, { ...caseForm })
    ElMessage.success('函台账已更新（库房账）')
  } else {
    await warehouseStore.createCase({ ...caseForm })
    ElMessage.success('已建函并记入库房账')
  }
  caseDialog.value = false
}

async function removeCase(row: CaseShelf): Promise<void> {
  try {
    await ElMessageBox.confirm(`将删除函 ${row.caseNo} 及其出库、工单、对账记录。`, '删除函', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const message = await warehouseStore.removeCase(row.id)
  if (message) ElMessage.warning(message)
  else ElMessage.success('已删除')
}

/* ----------------------------- 领册出库 ----------------------------- */
const checkoutDialog = ref(false)
const checkoutForm = reactive({ caseId: '', count: 1 })

const checkoutCase = computed(() => (checkoutForm.caseId ? warehouseStore.caseById(checkoutForm.caseId) : undefined))

/** 容量放满（在库不足）时提交即排队 */
const checkoutWillQueue = computed(
  () => checkoutCase.value !== undefined && checkoutForm.count > checkoutCase.value.inStockCount
)

const checkoutCaseOptions = computed(() =>
  warehouseStore.cases.map((row) => ({
    value: row.id,
    label: `${row.caseNo} · ${row.shelfLocation || '未排架'} · 在库 ${row.inStockCount}/${row.slotCapacity}`
  }))
)

function openCheckout(): void {
  const first = warehouseStore.cases[0]
  if (!first) {
    ElMessage.warning('请先建函')
    return
  }
  checkoutForm.caseId = first.id
  checkoutForm.count = 1
  checkoutDialog.value = true
}

async function submitCheckout(): Promise<void> {
  if (!checkoutForm.caseId) {
    ElMessage.warning('请选择函')
    return
  }
  try {
    const state = await warehouseStore.requestCheckout(checkoutForm.caseId, checkoutForm.count)
    if (state === 'fulfilled') ElMessage.success(`已出库 ${checkoutForm.count} 册，修复室工单已开立`)
    else ElMessage.warning('该函容量放满，已排队等别的册还回腾格')
    checkoutDialog.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '出库失败')
  }
}

async function cancelRequest(id: string): Promise<void> {
  await warehouseStore.cancelRequest(id)
  ElMessage.success('已取消排队')
}

/* ----------------------------- 两边对账 ----------------------------- */
interface ReconRow {
  caseId: string
  caseNo: string
  shelfLocation: string
  /** 库房账借出数 */
  warehouseOut: number
  /** 修复室账在修数 */
  workshopHolding: number
  /** 差值 = 工位在修 − 库房借出 */
  diff: number
  /** 差异涉及册号 */
  volumeNos: number[]
  lastReport: ReconReport | null
}

const reconRows = computed<ReconRow[]>(() =>
  warehouseStore.cases.map((cs) => {
    const related = workshopStore.orders.filter((order) => order.caseId === cs.id)
    const holdingIds = related.flatMap((order) => holdingVolumeIds(order))
    const warehouseOut = borrowedCount(cs)
    const lastReport =
      warehouseStore.reports
        .filter((report) => report.caseId === cs.id)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    return {
      caseId: cs.id,
      caseNo: cs.caseNo,
      shelfLocation: cs.shelfLocation,
      warehouseOut,
      workshopHolding: holdingIds.length,
      diff: holdingIds.length - warehouseOut,
      volumeNos: holdingIds.map((id) => volumeNoOf(id)).sort((a, b) => a - b),
      lastReport
    }
  })
)

const mismatchCount = computed(() => reconRows.value.filter((row) => row.diff !== 0).length)

function reconRowClass({ row }: { row: ReconRow }): string {
  return row.diff !== 0 ? 'is-mismatch' : ''
}

/** 工位按本侧重报：只留痕，库房函上的账原样留着 */
async function submitRecon(row: ReconRow): Promise<void> {
  await warehouseStore.reportRecon({
    caseId: row.caseId,
    warehouseOut: row.warehouseOut,
    workshopHolding: row.workshopHolding,
    volumeNos: row.volumeNos,
    note: '工位按本侧重报，库房账原样保留'
  })
  ElMessage.success(`函 ${row.caseNo} 已按工位账本重报（在修 ${row.workshopHolding} 册），库房账未改动`)
}

function volumeNosText(volumeNos: number[]): string {
  return volumeNos.length === 0 ? '—' : volumeNos.map((no) => `第 ${no} 册`).join('、')
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>库房架位台账</h2>
        <p>函上记架位、格位容量与当前在库册数；出库容量放满就排队，等别的册还回腾格</p>
      </div>
      <div class="gb-toolbar">
        <el-button type="primary" :icon="Plus" @click="openCaseCreate">新建函</el-button>
        <el-button :icon="Plus" @click="openCheckout">领册出库</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="函" :value="warehouseStore.cases.length" suffix="函" tone="primary" />
      <StatBadge label="格位总容量" :value="warehouseStore.totalCapacity" suffix="格" tone="info" />
      <StatBadge label="在库总册数" :value="warehouseStore.totalInStock" suffix="册" tone="success" />
      <StatBadge label="借出总册数" :value="warehouseStore.totalBorrowed" suffix="册" tone="warning" />
      <StatBadge label="排队中出库" :value="warehouseStore.queuedRequests.length" suffix="条" tone="danger" />
      <StatBadge label="账实不符" :value="mismatchCount" suffix="函" :tone="mismatchCount > 0 ? 'danger' : 'default'" />
    </div>

    <el-card shadow="never">
      <template #header>
        <span>函台账（库房账）</span>
      </template>
      <EmptyPanel
        v-if="warehouseStore.cases.length === 0"
        title="还没有函"
        description="建函后在函上记架位、格位容量与在库册数；升级旧数据会按函现有的册数回填历史格位。"
        action-text="新建函"
        size="small"
        @action="openCaseCreate"
      />
      <el-table v-else :data="warehouseStore.cases" size="small" border>
        <el-table-column prop="caseNo" label="函号" width="110" />
        <el-table-column label="所属古籍" min-width="150">
          <template #default="{ row }">《{{ bookTitle(row.bookId) }}》</template>
        </el-table-column>
        <el-table-column prop="shelfLocation" label="架位" min-width="140">
          <template #default="{ row }">{{ row.shelfLocation || '未排架' }}</template>
        </el-table-column>
        <el-table-column prop="slotCapacity" label="格位容量" width="90" align="center" />
        <el-table-column prop="inStockCount" label="在库册数" width="90" align="center" />
        <el-table-column label="借出" width="70" align="center">
          <template #default="{ row }">{{ borrowedCount(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag
              :style="{ color: CASE_STOCK_STATE_COLOR[caseStockState(row)], borderColor: `${CASE_STOCK_STATE_COLOR[caseStockState(row)]}66` }"
              effect="plain"
              round
            >
              {{ CASE_STOCK_STATE_LABEL[caseStockState(row)] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button size="small" text :icon="Edit" @click="openCaseEdit(row)">盘库</el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="removeCase(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-row :gutter="16" style="margin-top: 16px">
      <el-col :xs="24" :xl="10">
        <el-card shadow="never">
          <template #header>
            <span>出库请求（容量放满即排队）</span>
          </template>
          <EmptyPanel
            v-if="warehouseStore.recentRequests.length === 0"
            title="还没有出库请求"
            description="修复室领册出库：在库够就立即出库开工单，容量放满就排队等还回腾格。"
            size="small"
          />
          <template v-else>
            <el-table :data="warehouseStore.recentRequests" size="small" border>
              <el-table-column label="函号" width="100">
                <template #default="{ row }">{{ caseNo(row.caseId) }}</template>
              </el-table-column>
              <el-table-column prop="count" label="册数" width="60" align="center" />
              <el-table-column label="状态" width="90">
                <template #default="{ row }">
                  <el-tag
                    :style="{ color: CHECKOUT_STATE_COLOR[row.state as keyof typeof CHECKOUT_STATE_COLOR], borderColor: `${CHECKOUT_STATE_COLOR[row.state as keyof typeof CHECKOUT_STATE_COLOR]}66` }"
                    effect="plain"
                    round
                  >
                    {{ CHECKOUT_STATE_LABEL[row.state as keyof typeof CHECKOUT_STATE_LABEL] }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="提交时间" min-width="150">
                <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-button v-if="row.state === 'queued'" size="small" text type="danger" @click="cancelRequest(row.id)">
                    取消
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
            <p class="gb-muted" style="margin: 8px 0 0">
              排队中的请求会在工位还回册、腾出格位后按提交先后自动兑现。
            </p>
          </template>
        </el-card>
      </el-col>

      <el-col :xs="24" :xl="14">
        <el-card shadow="never">
          <template #header>
            <span>两边对账（按册数）</span>
          </template>
          <el-table :data="reconRows" size="small" border :row-class-name="reconRowClass">
            <el-table-column prop="caseNo" label="函号" width="100" />
            <el-table-column label="库房借出" width="90" align="center">
              <template #default="{ row }">{{ row.warehouseOut }}</template>
            </el-table-column>
            <el-table-column label="工位在修" width="90" align="center">
              <template #default="{ row }">{{ row.workshopHolding }}</template>
            </el-table-column>
            <el-table-column label="差值" width="80" align="center">
              <template #default="{ row }">
                <span :style="{ color: row.diff === 0 ? '#1e8449' : '#b03a2e', fontWeight: 600 }">
                  {{ row.diff === 0 ? '平' : (row.diff > 0 ? `+${row.diff}` : row.diff) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="涉及册号" min-width="130">
              <template #default="{ row }">{{ volumeNosText(row.volumeNos) }}</template>
            </el-table-column>
            <el-table-column label="最近重报" min-width="140">
              <template #default="{ row }">
                {{ row.lastReport ? formatTime(row.lastReport.createdAt) : '—' }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="130">
              <template #default="{ row }">
                <el-button size="small" text :disabled="row.diff === 0" @click="submitRecon(row)">
                  工位按本侧重报
                </el-button>
              </template>
            </el-table-column>
          </el-table>
          <p class="gb-muted" style="margin: 8px 0 0">
            对不上时摆出函号与册号；工位按本侧重报只留痕，库房函上的账原样留着。
          </p>
          <template v-if="warehouseStore.recentReports.length > 0">
            <el-divider style="margin: 12px 0" />
            <p class="gb-muted" style="margin: 0 0 6px">最近重报记录：</p>
            <p v-for="report in warehouseStore.recentReports" :key="report.id" class="gb-muted" style="margin: 2px 0">
              {{ formatTime(report.createdAt) }} · {{ caseNo(report.caseId) }} · 库房借出 {{ report.warehouseOut }} 册 /
              工位在修 {{ report.workshopHolding }} 册 · {{ volumeNosText(report.volumeNos) }}
            </p>
          </template>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="caseDialog" :title="caseEditing ? `盘库修正 · ${caseEditing.caseNo}` : '新建函'" width="520px">
      <el-form label-width="100px">
        <el-form-item label="所属古籍" required>
          <el-select v-model="caseForm.bookId" style="width: 100%" :disabled="caseEditing !== null" @change="onCaseBookChange">
            <el-option v-for="item in bookOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="函号" required>
          <el-input v-model="caseForm.caseNo" placeholder="如：函甲-01" />
        </el-form-item>
        <el-form-item label="架位">
          <el-input v-model="caseForm.shelfLocation" placeholder="如：甲字架 3 层 2 格" />
        </el-form-item>
        <el-form-item label="格位容量" required>
          <el-input-number v-model="caseForm.slotCapacity" :min="0" :max="999" style="width: 160px" />
        </el-form-item>
        <el-form-item label="在库册数" required>
          <el-input-number v-model="caseForm.inStockCount" :min="0" :max="caseForm.slotCapacity" style="width: 160px" />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="caseEditing"
        type="info"
        show-icon
        :closable="false"
        title="盘库修正只改库房这本账；与工位账对不上时在对账表里按册数核对"
      />
      <el-alert v-else type="info" show-icon :closable="false" title="新函格位容量默认按该古籍现有册数回填" />
      <template #footer>
        <el-button @click="caseDialog = false">取消</el-button>
        <el-button type="primary" @click="submitCase">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="checkoutDialog" title="领册出库" width="520px">
      <el-form label-width="100px">
        <el-form-item label="函" required>
          <el-select v-model="checkoutForm.caseId" style="width: 100%">
            <el-option v-for="item in checkoutCaseOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="领取册数" required>
          <el-input-number v-model="checkoutForm.count" :min="1" :max="checkoutCase ? checkoutCase.slotCapacity : 1" style="width: 160px" />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="checkoutWillQueue"
        type="warning"
        show-icon
        :closable="false"
        :title="`该函容量放满（在库 ${checkoutCase?.inStockCount ?? 0} 册），提交后排队等别的册还回腾格`"
      />
      <el-alert v-else type="success" show-icon :closable="false" title="在库充足，出库后立即开立修复工单" />
      <template #footer>
        <el-button @click="checkoutDialog = false">取消</el-button>
        <el-button type="primary" @click="submitCheckout">{{ checkoutWillQueue ? '排队等册' : '确认出库' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
:deep(.el-table .is-mismatch) {
  --el-table-tr-bg-color: #fbf0e4;
}
</style>
