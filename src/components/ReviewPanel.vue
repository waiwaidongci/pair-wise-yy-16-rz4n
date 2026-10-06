<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import type { DeviationSummary, FiringReview, KilnSession, RiskIssue } from '../types/firing'
import type { StaleItem } from '../utils/curve'
import { latestReview } from '../utils/curve'

const props = defineProps<{
  session: KilnSession
  staleItems: StaleItem[]
  viewingReview: FiringReview | null
  isViewingLatest: boolean
  issues: RiskIssue[]
  deviation: DeviationSummary
}>()

const emit = defineEmits<{
  publish: [note: string]
  view: [id: string | null]
}>()

const publishOpen = ref(false)
const publishNote = ref('')

const latest = computed(() => latestReview(props.session))
const sortedReviews = computed(() =>
  [...(props.session.reviews ?? [])].sort((a, b) => b.version - a.version),
)
const viewingId = computed(() => props.viewingReview?.id ?? latest.value?.id ?? null)

const statusSeverity = computed(() => {
  if (!latest.value) return 'secondary'
  return props.staleItems.length ? 'warn' : 'success'
})
const statusText = computed(() => {
  if (!latest.value) return '未发布'
  return props.staleItems.length ? '已过期' : '有效'
})

function formatDate(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function openPublish() {
  publishNote.value = ''
  publishOpen.value = true
}

function confirmPublish() {
  emit('publish', publishNote.value)
  publishOpen.value = false
}
</script>

<template>
  <section class="review-panel">
    <div class="review-heading">
      <div>
        <strong>烧成复核</strong>
        <span v-if="latest">
          最新版本 v{{ latest.version }} · {{ formatDate(latest.publishedAt) }}
          <template v-if="latest.origin === 'migration'"> · 升级补录</template>
        </span>
        <span v-else>尚未发布复核，发布时将冻结目标曲线、时间偏移、实测采样与风险结果</span>
      </div>
      <Tag :value="statusText" :severity="statusSeverity" />
    </div>

    <div v-if="staleItems.length" class="review-stale">
      <i class="pi pi-exclamation-triangle" />
      <div>
        <strong>复核已过期，需重新计算</strong>
        <p>
          自 v{{ latest?.version }} 发布后，以下项目已变更。旧版本结果保留为历史记录，
          重新发布将基于当前未提交内容创建新版本，不影响现有实测采样与曲线。
        </p>
        <ul>
          <li v-for="item in staleItems" :key="item.key">{{ item.label }}</li>
        </ul>
      </div>
    </div>

    <div v-if="!isViewingLatest && viewingReview" class="review-old">
      <i class="pi pi-history" />
      <div>
        <strong>正在查看历史版本 v{{ viewingReview.version }}</strong>
        <span>
          发布于 {{ formatDate(viewingReview.publishedAt) }}
          <template v-if="viewingReview.note"> · {{ viewingReview.note }}</template>
          ，下方风险与偏差为该版本冻结结果。
        </span>
      </div>
      <Button label="返回最新" size="small" outlined @click="emit('view', null)" />
    </div>

    <div class="review-versions">
      <button
        v-for="review in sortedReviews"
        :key="review.id"
        type="button"
        class="review-version"
        :class="{ 'review-version--active': review.id === viewingId }"
        @click="emit('view', review.id)"
      >
        <strong>v{{ review.version }}</strong>
        <span>{{ formatDate(review.publishedAt) }}</span>
        <Tag
          :value="review.id === latest?.id ? (staleItems.length ? '已过期' : '有效') : '历史'"
          :severity="review.id === latest?.id ? (staleItems.length ? 'warn' : 'success') : 'secondary'"
        />
      </button>
      <div v-if="!sortedReviews.length" class="review-versions__empty">暂无历史版本</div>
    </div>

    <div class="review-actions">
      <Button icon="pi pi-send" label="发布复核" @click="openPublish" />
      <span class="review-actions__hint">
        发布后冻结当前曲线、偏移、采样与 {{ issues.length }} 项风险结果（平均偏差 {{ deviation.meanAbs.toFixed(1) }} ℃）
      </span>
    </div>

    <Dialog v-model:visible="publishOpen" header="发布烧成复核" :style="{ width: '520px' }" modal>
      <div class="publish-dialog">
      <template v-if="latest">
        <p class="publish-dialog__lead">
          将基于当前未提交内容创建新版本 <strong>v{{ latest.version + 1 }}</strong>，
          旧版本 v{{ latest.version }} 及之前的冻结结果保留不变。
        </p>
        <div v-if="staleItems.length" class="publish-dialog__stale">
          <strong>自 v{{ latest.version }} 以来过期项（{{ staleItems.length }}）：</strong>
          <ul>
            <li v-for="item in staleItems" :key="item.key">{{ item.label }}</li>
          </ul>
        </div>
        <p v-else class="publish-dialog__clean">当前内容与 v{{ latest.version }} 冻结结果一致，将重新发布一版快照。</p>
      </template>
      <p v-else class="publish-dialog__lead">
        首次发布复核，将创建版本 <strong>v1</strong>，并冻结当前目标曲线、时间偏移、实测采样与全部风险结果。
      </p>
      <label class="publish-dialog__note">
        <span>版本备注（可选）</span>
        <InputText v-model="publishNote" placeholder="例如：青瓷三号窑次 1260 ℃ 复核" />
      </label>
      </div>
      <template #footer>
        <Button label="取消" severity="secondary" text @click="publishOpen = false" />
        <Button label="发布新版本" icon="pi pi-check" @click="confirmPublish" />
      </template>
    </Dialog>
  </section>
</template>

<style scoped>
.review-panel { display: grid; gap: 12px; padding: 15px 16px; }
.review-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.review-heading strong, .review-heading span { display: block; }
.review-heading strong { color: #49332a; font-size: 14px; }
.review-heading span { margin-top: 3px; color: #99847a; font-size: 10px; }
.review-stale {
  display: grid; gap: 8px; padding: 11px 13px;
  border: 1px solid #f0d9a8; border-radius: 8px; background: #fdf8ec;
  grid-template-columns: 20px 1fr;
}
.review-stale > i { color: #b98629; font-size: 15px; }
.review-stale strong { color: #8a6414; font-size: 12px; }
.review-stale p { margin: 4px 0 0; color: #8a7a52; font-size: 10px; line-height: 1.6; }
.review-stale ul { margin: 6px 0 0; padding-left: 18px; color: #8a6414; font-size: 10px; line-height: 1.7; }
.review-old {
  display: grid; gap: 8px; align-items: center; padding: 10px 13px;
  border: 1px solid #cfe0dd; border-radius: 8px; background: #f0f7f6;
  grid-template-columns: 20px 1fr auto;
}
.review-old > i { color: #4a7f86; font-size: 14px; }
.review-old strong { color: #365f64; font-size: 11px; }
.review-old span { display: block; margin-top: 2px; color: #6f8a8d; font-size: 10px; }
.review-versions { display: flex; flex-wrap: wrap; gap: 8px; }
.review-versions__empty { color: #a8968d; font-size: 10px; }
.review-version {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  border: 1px solid #e6ddd8; border-radius: 7px; background: #fff; cursor: pointer;
}
.review-version:hover { border-color: #d3a08a; }
.review-version--active { border-color: #c96f48; background: #fdf3ee; box-shadow: inset 3px 0 #c96f48; }
.review-version strong { color: #554037; font-size: 11px; }
.review-version span { color: #9b887e; font-size: 9px; }
.review-actions { display: flex; align-items: center; gap: 11px; }
.review-actions__hint { color: #9a877d; font-size: 10px; }
.publish-dialog { display: grid; gap: 12px; }
.publish-dialog__lead { margin: 0; color: #5c463c; font-size: 11px; line-height: 1.7; }
.publish-dialog__stale { padding: 10px 12px; border: 1px solid #f0d9a8; border-radius: 7px; background: #fdf8ec; }
.publish-dialog__stale strong { color: #8a6414; font-size: 11px; }
.publish-dialog__stale ul { margin: 5px 0 0; padding-left: 18px; color: #8a6414; font-size: 10px; line-height: 1.7; }
.publish-dialog__clean { margin: 0; color: #6f8a6d; font-size: 10px; }
.publish-dialog__note { display: grid; gap: 5px; color: #705a4f; font-size: 10px; }
</style>
