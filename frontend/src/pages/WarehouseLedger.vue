<script setup lang="ts">
/**
 * /storage 库房 × 修复室往来账
 * 两边各记一本：
 * - 库房账（函）：函号、架位、格位容量、当前在库册数；满格领书排队，还回腾格 FIFO 放出；
 * - 修复室账（工单）：按册开单，记领了哪几册、拆下多少书叶、修好还回几册。
 * 工位把册还回，库房在库数才跟着回；按册数对账，不符只准工位动自己这本。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, RefreshLeft, Van } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useBookStore } from '@/stores/bookStore'
import { useStorageStore, type LendDraft } from '@/stores/storageStore'
import { useReconcile, type CaseReconcileItem } from '@/hooks/useReconcile'
import type { RepairTicket } from '@/types/repairTicket'
import { TICKET_STATUS_COLOR, TICKET_STATUS_LABEL } from '@/types/repairTicket'
import { BINDING_TYPE_LABEL } from '@/types/volume'

const bookStore = useBookStore()
const storageStore = useStorageStore()

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function bookTitle(bookId: string): string {
  return bookStore.bookById(bookId)?.title ?? '（古籍已删除）'
}

function volumeLabel(volumeId: string): string {
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return `册已删除（${volumeId}）`
  return `《${bookTitle(volume.bookId)}》第 ${volume.volumeNo} 册`
}

function volumesOfCaseView(caseId: string): Array<{ value: string; label: string }> {
  const caseRecord = storageStore.caseById(caseId)
  if (!caseRecord) return []
  return bookStore.volumesOfBook(caseRecord.bookId).map((volume) => ({
    value: volume.id,
    label: `第 ${volume.volumeNo} 册 · ${BINDING_TYPE_LABEL[volume.bindingType]}`
  }))
}

/** 可领书的册：没有未还回工单的在册 */
const lendableVolumes = computed(() =>
  bookStore.volumes
    .filter((volume) => !storageStore.tickets.some((ticket) => ticket.volumeId === volume.id && ticket.status !== 'returned'))
    .map((volume) => ({
      value: volume.id,
      label: `${volumeLabel(volume.id)}`
    }))
)

const { reconciliations, mismatches, summary } = useReconcile(
  () => storageStore.cases,
  () => storageStore.tickets,
  {
    volumeLabelOf: volumeLabel,
    volumesOfCase: (caseRecord) =>
      bookStore.volumesOfBook(caseRecord.bookId).map((volume) => ({
        volumeId: volume.id,
        label: `第 ${volume.volumeNo} 册`
      }))
  }
)

function reconcileOfCase(caseId: string): CaseReconcileItem | undefined {
  return reconciliations.value.find((item) => item.caseRecord.id === caseId)
}

const caseStat = computed(() => ({
  totalCases: storageStore.cases.length,
  onShelf: storageStore.totalOnShelf,
  out: storageStore.outTicketCount,
  waiting: storageStore.waitingTicketCount,
  mismatch: summary.value.mismatched
}))

/* ------------------------------ 函档表单 ------------------------------ */
const caseDialog = ref(false)
const caseEditing = ref<string | null>(null)
const caseForm = reactive({ caseNo: '', bookId: '', shelfNo: '', capacity: 0 })

function openCreateCase(): void {
  const firstBook = bookStore.books.find((book) => !storageStore.caseOfBook(book.id))
  if (!firstBook) {
    ElMessage.warning('古籍都已建函档；请先到古籍台账新增古籍')
    return
  }
  caseEditing.value = null
  Object.assign(caseForm, { caseNo: '', bookId: firstBook.id, shelfNo: '', capacity: bookStore.volumesOfBook(firstBook.id).length })
  caseDialog.value = true
}

function openEditCase(caseId: string): void {
  const caseRecord = storageStore.caseById(caseId)
  if (!caseRecord) return
  caseEditing.value = caseId
  Object.assign(caseForm, {
    caseNo: caseRecord.caseNo,
    bookId: caseRecord.bookId,
    shelfNo: caseRecord.shelfNo,
    capacity: caseRecord.capacity
  })
  caseDialog.value = true
}

async function submitCase(): Promise<void> {
  const caseNo = caseForm.caseNo.trim()
  if (!caseNo) {
    ElMessage.warning('请填函号')
    return
  }
  if (!caseForm.bookId) {
    ElMessage.warning('请选择所属古籍')
    return
  }
  if (caseForm.capacity < 0) {
    ElMessage.warning('格位容量不能为负')
    return
  }
  try {
    if (caseEditing.value) {
      const current = storageStore.caseById(caseEditing.value)
      const occupied = current ? current.capacity - current.onShelfCount + current.waitQueue.length : 0
      if (caseForm.capacity < occupied) {
        ElMessage.warning(`容量不能小于当前在外册数（含候位 ${occupied} 册）`)
        return
      }
      await storageStore.updateCase(caseEditing.value, {
        caseNo,
        shelfNo: caseForm.shelfNo.trim(),
        capacity: caseForm.capacity
      })
      ElMessage.success('库房函档已更新')
    } else {
      const inStock = bookStore.volumesOfBook(caseForm.bookId).length
      await storageStore.createCase({
        caseNo,
        bookId: caseForm.bookId,
        shelfNo: caseForm.shelfNo.trim(),
        capacity: Math.max(caseForm.capacity, inStock),
        onShelfCount: inStock,
        waitQueue: [],
        historicalBackfill: false
      })
      ElMessage.success('函档已立，当前在册数已记入在库')
    }
    caseDialog.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败')
  }
}

async function removeCase(caseId: string): Promise<void> {
  const ticketCount = storageStore.ticketsOfCase(caseId).length
  try {
    await ElMessageBox.confirm(`删除函档会一并清掉修复室这本函的 ${ticketCount} 张工单，是否继续？`, '删除函档', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await storageStore.removeCase(caseId)
  ElMessage.success('函档已删')
}

/* ------------------------------ 领书工单 ------------------------------ */
const lendDialog = ref(false)
const lendForm = reactive({ volumeId: '', station: '', detachedLeaves: 0, lentDate: today() })

function openLend(): void {
  const first = lendableVolumes.value[0]
  if (!first) {
    ElMessage.warning('在册的册都已领出（或在候位），等还回腾格')
    return
  }
  Object.assign(lendForm, { volumeId: first.value, station: '', detachedLeaves: 0, lentDate: today() })
  lendDialog.value = true
}

async function submitLend(): Promise<void> {
  if (!lendForm.volumeId) {
    ElMessage.warning('请选择要领的册')
    return
  }
  const volume = bookStore.volumeById(lendForm.volumeId)
  if (!volume) return
  const draft: LendDraft = {
    volumeId: lendForm.volumeId,
    bookId: volume.bookId,
    station: lendForm.station.trim() || '未记工位',
    detachedLeaves: Number(lendForm.detachedLeaves) || 0,
    lentDate: lendForm.lentDate
  }
  try {
    const status = await storageStore.lendVolume(draft)
    if (status === 'waiting') ElMessage.warning('格位放满，工单已排队，等别的册还回腾格后按序放出')
    else ElMessage.success('已出库领走，库房在库册数减一')
    lendDialog.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '领书失败')
  }
}

async function returnTicket(ticket: RepairTicket): Promise<void> {
  let date = today()
  try {
    const { value } = await ElMessageBox.prompt('还回日期（库房在库数将随这本工单回涨）', '工位还回册', {
      confirmButtonText: '确认还回',
      cancelButtonText: '取消',
      inputValue: date,
      inputPattern: /^\d{4}-\d{2}-\d{2}$/,
      inputErrorMessage: '日期格式应为 yyyy-MM-dd'
    })
    date = value
  } catch {
    return
  }
  try {
    const released = await storageStore.returnVolume(ticket.id, date)
    ElMessage.success('册已还回，库房在库册数回涨')
    if (released.length > 0) ElMessage.info(`腾出空格，候位单已放出 ${released.length} 册`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '还回失败')
  }
}

async function cancelWaiting(ticket: RepairTicket): Promise<void> {
  try {
    await ElMessageBox.confirm('撤回这张候位工单并从队列移除（库房账不受影响）。', '撤回候位', {
      type: 'warning',
      confirmButtonText: '撤回',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await storageStore.cancelWaiting(ticket.id)
  ElMessage.success('候位工单已撤回')
}

/* --------------------------- 工位按本侧重报 --------------------------- */
const restateDialog = ref(false)
const restateForm = reactive({
  ticketId: '',
  station: '',
  detachedLeaves: 0,
  lentDate: today(),
  markReturned: false,
  returnedDate: today()
})

function openRestate(ticket: RepairTicket): void {
  Object.assign(restateForm, {
    ticketId: ticket.id,
    station: ticket.station,
    detachedLeaves: ticket.detachedLeaves,
    lentDate: ticket.lentDate || today(),
    markReturned: ticket.status === 'returned',
    returnedDate: ticket.returnedDate || today()
  })
  restateDialog.value = true
}

async function submitRestate(): Promise<void> {
  try {
    await storageStore.restateTicket(restateForm.ticketId, {
      station: restateForm.station.trim() || '未记工位',
      detachedLeaves: Number(restateForm.detachedLeaves) || 0,
      lentDate: restateForm.lentDate,
      ...(restateForm.markReturned
        ? { status: 'returned' as const, returnedCount: 1, returnedDate: restateForm.returnedDate }
        : { status: 'out' as const, returnedCount: 0, returnedDate: '' })
    })
    ElMessage.success('已按本侧重报，库房那份原样留着，请重新对账')
    restateDialog.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '重报失败')
  }
}

/** 工单多记且确认错领：工位撤自己这本，库房账不动 */
async function restateRemove(ticket: RepairTicket): Promise<void> {
  try {
    await ElMessageBox.confirm('该册确认未实际领出？仅撤回修复室这本工单，库房在库数不动。', '错领撤单', {
      type: 'warning',
      confirmButtonText: '撤单',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await storageStore.restateRemoveTicket(ticket.id)
  ElMessage.success('工单已撤回，请重新对账')
}

/* --------------------- 工单少记：工位补报（不碰库房账） --------------------- */
const missingDialog = ref(false)
const missingForm = reactive({ caseId: '', volumeId: '', station: '', detachedLeaves: 0, lentDate: today() })

function openRestateCreate(item: CaseReconcileItem, volumeId: string): void {
  Object.assign(missingForm, {
    caseId: item.caseRecord.id,
    volumeId,
    station: '',
    detachedLeaves: bookStore.volumeById(volumeId)?.leafCount ?? 0,
    lentDate: today()
  })
  missingDialog.value = true
}

async function submitMissing(): Promise<void> {
  if (!missingForm.volumeId) {
    ElMessage.warning('请选择实际在外的册')
    return
  }
  await storageStore.restateCreateTicket({
    volumeId: missingForm.volumeId,
    caseId: missingForm.caseId,
    station: missingForm.station.trim() || '未记工位',
    lentDate: missingForm.lentDate,
    detachedLeaves: Number(missingForm.detachedLeaves) || 0,
    returnedCount: 0,
    returnedDate: '',
    restatedAt: null,
    status: 'out'
  })
  ElMessage.success('已补报工单（修复室这本），库房那份原样留着，请重新对账')
  missingDialog.value = false
}

/* ------------------------------ 展示辅助 ------------------------------ */

/** 对账明细「工单多记」：该册在修复室那本未还回工单（明细未带工单 id 时按册号回捞） */
function activeTicketOfVolume(volumeId: string): RepairTicket | undefined {
  return storageStore.tickets.find((ticket) => ticket.volumeId === volumeId && ticket.status !== 'returned')
}

function restateByVolume(volumeId: string): void {
  const ticket = activeTicketOfVolume(volumeId)
  if (ticket) openRestate(ticket)
}

function removeByVolume(volumeId: string): void {
  const ticket = activeTicketOfVolume(volumeId)
  if (ticket) void restateRemove(ticket)
}

function queuePosition(caseId: string, ticketId: string): number {
  const caseRecord = storageStore.caseById(caseId)
  if (!caseRecord) return 0
  return caseRecord.waitQueue.findIndex((item) => item.ticketId === ticketId) + 1
}

function shelfPercent(onShelf: number, capacity: number): number {
  if (capacity <= 0) return 0
  return Math.round((onShelf / capacity) * 100)
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>书库 × 修复室往来账</h2>
        <p>库房在函上记架位、格位容量、当前在库册数；修复室按册开工单，记领出、拆叶、还回。满格领书排队，还回腾格放出。</p>
      </div>
      <div class="gb-toolbar">
        <el-button :icon="Plus" @click="openCreateCase">登记函档</el-button>
        <el-button type="primary" :icon="Van" @click="openLend">工位领书</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="在架函档" :value="caseStat.totalCases" suffix="函" tone="primary" />
      <StatBadge label="当前在库" :value="caseStat.onShelf" suffix="册" tone="success" />
      <StatBadge label="领出在修" :value="caseStat.out" suffix="册" tone="danger" />
      <StatBadge label="候位排队" :value="caseStat.waiting" suffix="册" tone="warning" />
      <StatBadge label="对账不符" :value="caseStat.mismatch" suffix="函" tone="danger" icon="WarningFilled" />
    </div>

    <!-- 库房那本账 -->
    <el-card shadow="never" class="gb-panel">
      <template #header>
        <div style="display: flex; align-items: center; justify-content: space-between">
          <span>库房账 · 函（架位 / 格位容量 / 在库册数）</span>
          <span class="gb-muted">出库满格即排队，等还回腾格</span>
        </div>
      </template>
      <EmptyPanel
        v-if="storageStore.cases.length === 0"
        title="还没有函档"
        description="一部古籍按一函上架，先登记函号、架位与格位容量。"
        action-text="登记函档"
        @action="openCreateCase"
      />
      <el-table v-else :data="storageStore.cases" size="small" border>
        <el-table-column prop="caseNo" label="函号" width="120" />
        <el-table-column label="古籍" min-width="160">
          <template #default="{ row }">《{{ bookTitle(row.bookId) }}》</template>
        </el-table-column>
        <el-table-column label="架位" min-width="150">
          <template #default="{ row }">
            <span v-if="row.shelfNo">{{ row.shelfNo }}</span>
            <el-tag v-else size="small" type="info">架位待补编</el-tag>
            <el-tag v-if="row.historicalBackfill" size="small" type="warning" effect="plain" style="margin-left: 6px">
              历史回填
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="在库 / 容量" width="170">
          <template #default="{ row }">
            <div>{{ row.onShelfCount }} / {{ row.capacity }} 册</div>
            <el-progress :percentage="shelfPercent(row.onShelfCount, row.capacity)" :stroke-width="6" :show-text="false" />
          </template>
        </el-table-column>
        <el-table-column label="候位队列" min-width="150">
          <template #default="{ row }">
            <span v-if="row.waitQueue.length === 0" class="gb-muted">—</span>
            <el-tag v-for="(item, index) in row.waitQueue" :key="item.ticketId" size="small" type="warning" style="margin: 2px">
              第 {{ index + 1 }} 位 · {{ volumeLabel(item.volumeId) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对账" width="90">
          <template #default="{ row }">
            <el-tag
              v-if="reconcileOfCase(row.id)?.matched"
              size="small"
              type="success"
              effect="plain"
            >平</el-tag>
            <el-tag v-else size="small" type="danger" effect="plain">不符</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130">
          <template #default="{ row }">
            <el-button size="small" text :icon="Edit" @click="openEditCase(row.id)">改架位/容量</el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="removeCase(row.id)">删</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 修复室那本账 -->
    <el-card shadow="never" class="gb-panel">
      <template #header>
        <div style="display: flex; align-items: center; justify-content: space-between">
          <span>修复室账 · 工单（按册开单：领出 / 拆叶 / 还回）</span>
          <span class="gb-muted">工位还册后库房在库数才回涨</span>
        </div>
      </template>
      <EmptyPanel
        v-if="storageStore.tickets.length === 0"
        title="还没有领书工单"
        description="修复室领书按册开工单；一次可领半函，未还前架位一直占着。"
        action-text="工位领书"
        @action="openLend"
      />
      <el-table v-else :data="storageStore.tickets" size="small" border>
        <el-table-column label="函号 / 册号" min-width="200">
          <template #default="{ row }">
            <div>{{ storageStore.caseById(row.caseId)?.caseNo ?? '函已删除' }}</div>
            <div class="gb-muted">{{ volumeLabel(row.volumeId) }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="station" label="领书工位" width="130" />
        <el-table-column prop="lentDate" label="领书日期" width="110" sortable />
        <el-table-column prop="detachedLeaves" label="拆下书叶" width="90" align="center" />
        <el-table-column label="还回" width="110" align="center">
          <template #default="{ row }">
            <span v-if="row.status === 'returned'">{{ row.returnedCount }} 册 · {{ row.returnedDate }}</span>
            <span v-else class="gb-muted">未还</span>
          </template>
        </el-table-column>
        <el-table-column label="状态 / 排队" width="120">
          <template #default="{ row }">
            <el-tag size="small" :style="{ color: TICKET_STATUS_COLOR[row.status as keyof typeof TICKET_STATUS_COLOR] }" effect="plain">
              {{ TICKET_STATUS_LABEL[row.status as keyof typeof TICKET_STATUS_LABEL] }}
            </el-tag>
            <div v-if="row.status === 'waiting'" class="gb-muted">第 {{ queuePosition(row.caseId, row.id) }} 位</div>
            <el-tag v-if="row.restatedAt" size="small" type="info" effect="plain" style="margin-top: 2px">已重报</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210">
          <template #default="{ row }">
            <el-button v-if="row.status === 'out'" size="small" type="success" plain :icon="RefreshLeft" @click="returnTicket(row)">
              还回
            </el-button>
            <el-button v-if="row.status === 'waiting'" size="small" type="warning" plain @click="cancelWaiting(row)">
              撤回候位
            </el-button>
            <el-button size="small" text :icon="Edit" @click="openRestate(row)">重报</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 对账 -->
    <el-card shadow="never" class="gb-panel">
      <template #header>两边按册数对账（容量 = 在库 + 在外；不符只摆册号，库房那份原样留着）</template>
      <el-alert
        v-if="mismatches.length === 0"
        type="success"
        show-icon
        :closable="false"
        :title="`${summary.total} 函全部对平（在库与工单一致）`"
      />
      <template v-else>
        <el-alert
          v-for="item in mismatches"
          :key="item.caseRecord.id"
          type="error"
          show-icon
          :closable="false"
          style="margin-bottom: 10px"
          :title="`${item.caseRecord.caseNo}（《${bookTitle(item.caseRecord.bookId)}》）对不上：库房口径在外 ${item.expectedOut} 册，修复室工单在外 ${item.actualOut} 册`"
        >
          <div class="reco-list">
            <div v-for="detail in item.details" :key="detail.volumeId || detail.kind" class="reco-row">
              <el-tag size="small" :type="detail.kind === 'ticket-extra' ? 'danger' : 'warning'" effect="plain">
                {{ detail.kind === 'ticket-extra' ? '工单多记' : '工单少记' }}
              </el-tag>
              <span class="reco-volume">{{ detail.volumeLabel }}</span>
              <template v-if="detail.kind === 'ticket-extra'">
                <el-button size="small" text type="success" @click="restateByVolume(detail.volumeId)">
                  认已还回（重报）
                </el-button>
                <el-button size="small" text type="danger" @click="removeByVolume(detail.volumeId)">
                  错领撤单
                </el-button>
              </template>
              <el-button v-else size="small" text type="primary" @click="openRestateCreate(item, detail.volumeId)">
                工位补报
              </el-button>
            </div>
          </div>
        </el-alert>
        <p class="gb-muted">处理原则：工位按本侧重报 / 补报 / 撤单，库房在库数与队列一律不动，重报后重新对账。</p>
      </template>
    </el-card>

    <!-- 函档对话框 -->
    <el-dialog v-model="caseDialog" :title="caseEditing ? '改函档（架位 / 容量）' : '登记函档'" width="520px">
      <el-form label-width="92px">
        <el-form-item label="所属古籍" required>
          <el-select v-model="caseForm.bookId" style="width: 100%" :disabled="caseEditing !== null">
            <el-option
              v-for="book in bookStore.books"
              :key="book.id"
              :label="`《${book.title}》`"
              :value="book.id"
              :disabled="caseEditing === null && !!storageStore.caseOfBook(book.id)"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="函号" required>
          <el-input v-model="caseForm.caseNo" placeholder="如 函-甲-017" />
        </el-form-item>
        <el-form-item label="架位">
          <el-input v-model="caseForm.shelfNo" placeholder="如 甲库·三排·二格（历史回填函待补编）" />
        </el-form-item>
        <el-form-item label="格位容量" required>
          <el-input-number v-model="caseForm.capacity" :min="0" :max="999" />
          <span class="gb-muted" style="margin-left: 8px">册；在库册数由领书 / 还回自动记</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="caseDialog = false">取消</el-button>
        <el-button type="primary" @click="submitCase">保存</el-button>
      </template>
    </el-dialog>

    <!-- 领书对话框 -->
    <el-dialog v-model="lendDialog" title="工位领书（修复室开工单）" width="520px">
      <el-form label-width="92px">
        <el-form-item label="领哪一册" required>
          <el-select v-model="lendForm.volumeId" filterable style="width: 100%">
            <el-option v-for="item in lendableVolumes" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="工位">
          <el-input v-model="lendForm.station" placeholder="如 沈玉·二号台" />
        </el-form-item>
        <el-form-item label="拆下书叶">
          <el-input-number v-model="lendForm.detachedLeaves" :min="0" :max="9999" />
          <span class="gb-muted" style="margin-left: 8px">叶</span>
        </el-form-item>
        <el-form-item label="领书日期">
          <el-input v-model="lendForm.lentDate" type="date" />
        </el-form-item>
      </el-form>
      <el-alert type="info" show-icon :closable="false" title="格位放满时工单自动排队，库房在库数不动；等有册还回腾格再按序放出。" />
      <template #footer>
        <el-button @click="lendDialog = false">取消</el-button>
        <el-button type="primary" @click="submitLend">开单领书</el-button>
      </template>
    </el-dialog>

    <!-- 重报对话框 -->
    <el-dialog v-model="restateDialog" title="工位按本侧重报工单" width="520px">
      <el-form label-width="92px">
        <el-form-item label="工位">
          <el-input v-model="restateForm.station" />
        </el-form-item>
        <el-form-item label="拆下书叶">
          <el-input-number v-model="restateForm.detachedLeaves" :min="0" :max="9999" />
        </el-form-item>
        <el-form-item label="领书日期">
          <el-input v-model="restateForm.lentDate" type="date" />
        </el-form-item>
        <el-form-item label="重报结论">
          <el-switch v-model="restateForm.markReturned" active-text="已修好还回" inactive-text="仍在修" />
        </el-form-item>
        <el-form-item v-if="restateForm.markReturned" label="还回日期">
          <el-input v-model="restateForm.returnedDate" type="date" />
        </el-form-item>
      </el-form>
      <el-alert type="warning" show-icon :closable="false" title="只改修复室这本工单并留重报痕迹，库房在库数与队列原样不动。" />
      <template #footer>
        <el-button @click="restateDialog = false">取消</el-button>
        <el-button type="primary" @click="submitRestate">提交重报</el-button>
      </template>
    </el-dialog>

    <!-- 补报对话框 -->
    <el-dialog v-model="missingDialog" title="工位补报在外册工单" width="520px">
      <el-form label-width="92px">
        <el-form-item label="在外的册" required>
          <el-select v-model="missingForm.volumeId" filterable style="width: 100%">
            <el-option v-for="item in volumesOfCaseView(missingForm.caseId)" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="工位">
          <el-input v-model="missingForm.station" placeholder="如 陆敏·一号台" />
        </el-form-item>
        <el-form-item label="拆下书叶">
          <el-input-number v-model="missingForm.detachedLeaves" :min="0" :max="9999" />
        </el-form-item>
        <el-form-item label="领书日期">
          <el-input v-model="missingForm.lentDate" type="date" />
        </el-form-item>
      </el-form>
      <el-alert type="warning" show-icon :closable="false" title="补报只入修复室这本账，不扣库房在库数；由库房核对后自行处理。" />
      <template #footer>
        <el-button @click="missingDialog = false">取消</el-button>
        <el-button type="primary" @click="submitMissing">补报</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.reco-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}

.reco-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.reco-volume {
  font-size: 13px;
}
</style>
