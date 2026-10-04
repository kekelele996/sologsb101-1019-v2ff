<script setup lang="ts">
/**
 * /workshop 修复室工单（工位那本账）
 * 按册开工单：记领了哪几册、拆下多少书叶、修好还回几册；
 * 工位把册还回，库房函上的在库数才跟着回。
 * 消费 WorkOrder（关联 CaseShelf、Volume）；复用 <StatBadge>、<EmptyPanel>。
 */
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useBookStore } from '@/stores/bookStore'
import { useWarehouseStore } from '@/stores/warehouseStore'
import { useWorkshopStore } from '@/stores/workshopStore'
import {
  WORK_ORDER_STATE_COLOR,
  WORK_ORDER_STATE_LABEL,
  holdingVolumeIds,
  type WorkOrder
} from '@/types/workOrder'

const bookStore = useBookStore()
const warehouseStore = useWarehouseStore()
const workshopStore = useWorkshopStore()

function caseNo(caseId: string): string {
  return warehouseStore.caseById(caseId)?.caseNo ?? '函已删除'
}

function volumeNoOf(volumeId: string): number {
  return bookStore.volumeById(volumeId)?.volumeNo ?? 0
}

function volumeNoText(volumeIds: string[]): string {
  if (volumeIds.length === 0) return '—'
  return volumeIds
    .map((id) => volumeNoOf(id))
    .sort((a, b) => a - b)
    .map((no) => `第 ${no} 册`)
    .join('、')
}

/* ----------------------------- 拆下书叶登记 ----------------------------- */
const leafDialog = ref(false)
const leafTarget = ref<WorkOrder | null>(null)
const leafCount = ref(0)

function openLeaves(order: WorkOrder): void {
  leafTarget.value = order
  leafCount.value = order.removedLeafCount
  leafDialog.value = true
}

async function submitLeaves(): Promise<void> {
  if (!leafTarget.value) return
  await workshopStore.updateRemovedLeaves(leafTarget.value.id, leafCount.value)
  ElMessage.success(`工单 ${leafTarget.value.orderNo} 已登记拆下书叶 ${leafCount.value} 叶`)
  leafDialog.value = false
}

/* ----------------------------- 修好还回 ----------------------------- */
const returnDialog = ref(false)
const returnTarget = ref<WorkOrder | null>(null)
const returnSelection = ref<string[]>([])

const holdingOptions = computed(() => (returnTarget.value ? holdingVolumeIds(returnTarget.value) : []))

function openReturn(order: WorkOrder): void {
  returnTarget.value = order
  returnSelection.value = [...holdingVolumeIds(order)]
  returnDialog.value = true
}

async function submitReturn(): Promise<void> {
  if (!returnTarget.value) return
  if (returnSelection.value.length === 0) {
    ElMessage.warning('请选择本次还回的册')
    return
  }
  const count = returnSelection.value.length
  const orderNo = returnTarget.value.orderNo
  const fulfilled = await workshopStore.returnVolumes(returnTarget.value.id, returnSelection.value)
  returnDialog.value = false
  ElMessage.success(
    fulfilled > 0
      ? `工单 ${orderNo} 还回 ${count} 册，库房在库数已跟着回；排队的出库请求兑现 ${fulfilled} 条`
      : `工单 ${orderNo} 还回 ${count} 册，库房在库数已跟着回`
  )
}

async function removeOrder(order: WorkOrder): Promise<void> {
  try {
    await ElMessageBox.confirm(`将删除工单 ${order.orderNo}（已还齐）。`, '删除工单', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await workshopStore.removeOrder(order.id)
  ElMessage.success('已删除')
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>修复室工单</h2>
        <p>按册开工单：领了哪几册、拆下多少书叶、修好还回几册；工单由库房出库自动开立</p>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="工单" :value="workshopStore.orders.length" suffix="张" tone="primary" />
      <StatBadge label="未还齐工单" :value="workshopStore.openOrders.length" suffix="张" tone="warning" />
      <StatBadge label="在修册数" :value="workshopStore.holdingCount" suffix="册" tone="danger" />
      <StatBadge label="拆下书叶" :value="workshopStore.removedLeafTotal" suffix="叶" tone="info" />
      <StatBadge label="修好还回" :value="workshopStore.returnedTotal" suffix="册" tone="success" />
    </div>

    <el-card shadow="never">
      <template #header>
        <span>工单台账（修复室账）</span>
      </template>
      <EmptyPanel
        v-if="workshopStore.orders.length === 0"
        title="还没有工单"
        description="到库房架位台账领册出库后，工单自动开立；还回册时库房在库数跟着回。"
        size="small"
      />
      <el-table v-else :data="workshopStore.orders" size="small" border>
        <el-table-column prop="orderNo" label="工单号" width="100" />
        <el-table-column label="函号" width="100">
          <template #default="{ row }">{{ caseNo(row.caseId) }}</template>
        </el-table-column>
        <el-table-column label="领了哪几册" min-width="150">
          <template #default="{ row }">{{ volumeNoText(row.volumeIds) }}</template>
        </el-table-column>
        <el-table-column label="拆下书叶" width="100" align="center">
          <template #default="{ row }">{{ row.removedLeafCount }} 叶</template>
        </el-table-column>
        <el-table-column label="还回进度" width="90" align="center">
          <template #default="{ row }">{{ row.returnedVolumeIds.length }}/{{ row.volumeIds.length }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag
              :style="{ color: WORK_ORDER_STATE_COLOR[row.state as keyof typeof WORK_ORDER_STATE_COLOR], borderColor: `${WORK_ORDER_STATE_COLOR[row.state as keyof typeof WORK_ORDER_STATE_COLOR]}66` }"
              effect="plain"
              round
            >
              {{ WORK_ORDER_STATE_LABEL[row.state as keyof typeof WORK_ORDER_STATE_LABEL] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220">
          <template #default="{ row }">
            <el-button size="small" text :icon="Edit" @click="openLeaves(row)">登记拆叶</el-button>
            <el-button size="small" text :disabled="row.state === 'closed'" @click="openReturn(row)">还回</el-button>
            <el-button
              size="small"
              text
              type="danger"
              :icon="Delete"
              :disabled="row.state !== 'closed'"
              @click="removeOrder(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="leafDialog" :title="`登记拆下书叶 · ${leafTarget?.orderNo ?? ''}`" width="420px">
      <el-form label-width="100px">
        <el-form-item label="拆下书叶" required>
          <el-input-number v-model="leafCount" :min="0" :max="9999" style="width: 160px" />
          <span class="gb-muted" style="margin-left: 8px">叶</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="leafDialog = false">取消</el-button>
        <el-button type="primary" @click="submitLeaves">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="returnDialog" :title="`修好还回 · ${returnTarget?.orderNo ?? ''}`" width="460px">
      <p class="gb-muted" style="margin: 0 0 10px">
        勾选本次还回的册；确认后库房函 {{ returnTarget ? caseNo(returnTarget.caseId) : '' }} 的在库数跟着回。
      </p>
      <el-checkbox-group v-model="returnSelection">
        <el-checkbox v-for="vid in holdingOptions" :key="vid" :value="vid" style="display: flex">
          第 {{ volumeNoOf(vid) }} 册
        </el-checkbox>
      </el-checkbox-group>
      <template #footer>
        <el-button @click="returnDialog = false">取消</el-button>
        <el-button type="primary" @click="submitReturn">确认还回</el-button>
      </template>
    </el-dialog>
  </div>
</template>
