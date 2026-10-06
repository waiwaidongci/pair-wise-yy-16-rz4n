<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Dialog from 'primevue/dialog'
import type { KilnSession, ReviewSnapshot, StaleField } from '../types/firing'
import {
  STALE_FIELD_LABELS,
  latestReview,
  snapshotToSession,
  staleFieldsSince,
} from '../utils/review'
import { buildStages, calculateDeviation, validateCurve } from '../utils/curve'
import CurveChart from './CurveChart.vue'
import StagePanel from './StagePanel.vue'
import RiskSummary from './RiskSummary.vue'
import DeviationPanel from './DeviationPanel.vue'

const props = defineProps<{
  session: KilnSession
  staleFields: StaleField[]
  clientLabel: string
}>()

const emit = defineEmits<{
  publish: []
}>()

const detailVersion = ref<number | null>(null)
const detailOpen = computed({
  get: () => detailVersion.value !== null,
  set: (open: boolean) => {
    if (!open) detailVersion.value = null
  },
})

const sortedReviews = computed(() => [...props.session.reviews].sort((a, b) => b.version - a.version))
const current = computed(() => latestReview(props.session))
const detailReview = computed(() => props.session.reviews.find((review) => review.version === detailVersion.value) ?? null)
const detailSession = computed(() => (detailReview.value ? snapshotToSession(detailReview.value) : null))
const detailStale = computed(() =>
  detailReview.value ? staleFieldsSince(detailReview.value, props.session) : [],
)
const detailStages = computed(() => (detailSession.value ? buildStages(detailSession.value.points) : []))
const detailLiveDeviation = computed(() =>
  detailSession.value
    ? calculateDeviation(detailSession.value.points, detailSession.value.actualSamples, detailSession.value.timeOffsetMin)
    : null,
)
const detailLiveIssues = computed(() => (detailSession.value ? validateCurve(detailSession.value) : []))

function formatTime(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function isCurrent(review: ReviewSnapshot) {
  return current.value?.id === review.id
}
</script>

<template>
  <section class="review-center">
    <div class="panel-title review-heading">
      <div>
        <strong>版本化复核</strong>
        <span>发布时冻结目标曲线、时间偏移、实测采样与风险结果；之后任一冻结项改动，旧复核立即失效</span>
      </div>
      <Button
        icon="pi pi-verified"
        label="发布复核"
        :disabled="!session.actualSamples.length"
        @click="emit('publish')"
      />
    </div>

    <div v-if="!session.actualSamples.length" class="review-empty">
      尚未导入记录仪数据，无法发布复核。请先在「窑次管理」导入 CSV。
    </div>
    <div v-else-if="!current" class="review-empty">
      当前窑次已有 {{ session.actualSamples.length }} 个实测点，但还没有发布过复核。
    </div>

    <div v-if="current" class="review-current" :class="{ 'review-current--stale': staleFields.length }">
      <div class="review-current__top">
        <div>
          <strong>最新复核 v{{ current.version }}</strong>
          <span>{{ formatTime(current.publishedAt) }} · {{ current.clientLabel }}</span>
        </div>
        <Tag v-if="staleFields.length" value="已过期" severity="danger" icon="pi pi-exclamation-triangle" />
        <Tag v-else value="有效" severity="success" icon="pi pi-check-circle" />
      </div>
      <div class="review-metrics">
        <span>冻结平均偏差 <strong>{{ current.deviation.meanAbs.toFixed(1) }} ℃</strong></span>
        <span>冻结最大偏差 <strong>{{ current.deviation.maxAbs.toFixed(1) }} ℃</strong></span>
        <span>冻结风险 <strong>{{ current.risks.length }} 项</strong></span>
        <span>冻结偏移 <strong>{{ current.timeOffsetMin }} min</strong></span>
      </div>
      <div v-if="staleFields.length" class="stale-line">
        <i class="pi pi-warning-circle" />
        <span>
          以下项在发布后被改动，v{{ current.version }} 的冻结结果仅作历史参考，页面中的偏差与风险已按最新数据重新计算：
          <em v-for="field in staleFields" :key="field">{{ STALE_FIELD_LABELS[field] }}</em>
        </span>
      </div>
      <p v-if="current.note" class="review-note"><i class="pi pi-comment" />{{ current.note }}</p>
    </div>

    <div v-if="sortedReviews.length" class="review-history">
      <div class="review-history__title"><span>历史版本（{{ sortedReviews.length }}）</span></div>
      <button
        v-for="review in sortedReviews"
        :key="review.id"
        type="button"
        class="review-row"
        :class="{ 'review-row--current': isCurrent(review) }"
        @click="detailVersion = review.version"
      >
        <span class="review-row__version">v{{ review.version }}</span>
        <span class="review-row__body">
          <strong>{{ formatTime(review.publishedAt) }}</strong>
          <small>{{ review.clientLabel }} · 偏差 {{ review.deviation.meanAbs.toFixed(1) }}℃ · 风险 {{ review.risks.length }} 项</small>
        </span>
        <Tag
          :value="isCurrent(review) ? (staleFields.length ? '已过期' : '有效') : '历史'"
          :severity="isCurrent(review) ? (staleFields.length ? 'danger' : 'success') : 'secondary'"
        />
      </button>
    </div>

    <Dialog
      v-model:visible="detailOpen"
      :header="`复核 v${detailReview?.version ?? ''} 冻结快照`"
      :style="{ width: '1080px' }"
      modal
    >
      <template v-if="detailReview && detailSession">
        <div class="detail-banner">
          <div>
            <strong>发布于 {{ formatTime(detailReview.publishedAt) }}</strong>
            <span>{{ detailReview.clientLabel }} · 快照不可编辑，只用于核对发布当时的结论</span>
          </div>
          <Tag v-if="detailStale.length" value="该版本已过期" severity="danger" />
          <Tag v-else value="与当前一致" severity="success" />
        </div>
        <div v-if="detailStale.length" class="detail-stale">
          与当前窑次相比，过期项：
          <em v-for="field in detailStale" :key="field">{{ STALE_FIELD_LABELS[field] }}</em>
        </div>
        <CurveChart
          :sessions="[detailSession]"
          :active-session-id="detailSession.id"
          :interactive="false"
          :show-actual="true"
        />
        <div class="detail-grid">
          <div>
            <div class="frozen-label"><i class="pi pi-snowflake" />发布时冻结的风险结果</div>
            <RiskSummary :issues="detailReview.risks" />
          </div>
          <div>
            <div class="frozen-label frozen-label--live"><i class="pi pi-bolt" />按当前数据重新计算</div>
            <RiskSummary :issues="detailLiveIssues" />
          </div>
        </div>
        <div class="detail-grid">
          <div class="frozen-card">
            <div class="frozen-label"><i class="pi pi-snowflake" />冻结偏差 · 偏移 {{ detailReview.timeOffsetMin }} min</div>
            <DeviationPanel :summary="detailReview.deviation" :offset-min="detailReview.timeOffsetMin" readonly />
          </div>
          <div class="frozen-card">
            <div class="frozen-label frozen-label--live"><i class="pi pi-bolt" />实时偏差 · 偏移 {{ detailSession.timeOffsetMin }} min</div>
            <DeviationPanel
              v-if="detailLiveDeviation"
              :summary="detailLiveDeviation"
              :offset-min="detailSession.timeOffsetMin"
              readonly
            />
          </div>
        </div>
        <StagePanel :stages="detailStages" :issues="detailReview.risks" :selected-index="null" />
      </template>
    </Dialog>
  </section>
</template>

<style scoped>
.review-center { overflow: hidden; border: 1px solid #e5dcd5; border-radius: 10px; background: #fff; box-shadow: 0 10px 28px rgba(73, 46, 35, .05); }
.review-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px 11px; border-bottom: 1px solid #ece5e0; }
.review-heading strong, .review-heading span { display: block; }
.review-heading strong { color: #4b332c; font-size: 13px; }
.review-heading span { margin-top: 3px; color: #9a877d; font-size: 10px; }
.review-empty { margin: 12px 16px; padding: 12px; border-radius: 8px; background: #f5f7f6; color: #85938f; font-size: 11px; line-height: 1.7; }
.review-current { margin: 12px 16px 0; padding: 13px 14px; border: 1px solid #d9e8dd; border-radius: 9px; background: #f4faf5; }
.review-current--stale { border-color: #eecfc1; background: #fff7f2; }
.review-current__top { display: flex; align-items: flex-start; justify-content: space-between; }
.review-current__top strong, .review-current__top span { display: block; }
.review-current__top strong { color: #385648; font-size: 13px; }
.review-current--stale .review-current__top strong { color: #9e4427; }
.review-current__top span { margin-top: 3px; color: #8ca095; font-size: 10px; }
.review-current--stale .review-current__top span { color: #b08b79; }
.review-metrics { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 11px; }
.review-metrics span { color: #84938a; font-size: 10px; }
.review-metrics strong { margin-left: 4px; color: #346156; font-size: 12px; }
.stale-line { display: flex; gap: 8px; margin-top: 11px; padding: 9px 10px; border-radius: 7px; background: #fdece3; color: #96411f; font-size: 10px; line-height: 1.8; }
.stale-line i { margin-top: 2px; }
.stale-line em { display: inline-block; margin: 0 4px; padding: 1px 8px; border-radius: 999px; background: #fff; font-style: normal; font-weight: 700; }
.review-note { margin: 9px 2px 0; color: #8a7467; font-size: 10px; }
.review-note i { margin-right: 5px; }
.review-history { margin: 12px 16px 15px; }
.review-history__title { padding-bottom: 8px; color: #9a877d; font-size: 10px; border-bottom: 1px solid #f0eae6; }
.review-row { display: flex; width: 100%; align-items: center; gap: 11px; padding: 9px 8px; border: 0; border-bottom: 1px solid #f5efeb; background: #fff; cursor: pointer; text-align: left; }
.review-row:hover { background: #fbf7f4; }
.review-row--current { background: #fdf8f4; }
.review-row__version { display: grid; width: 38px; height: 28px; place-items: center; border-radius: 7px; background: #efe2da; color: #96523a; font-family: Menlo, monospace; font-size: 11px; font-weight: 700; }
.review-row__body { flex: 1; }
.review-row__body strong, .review-row__body small { display: block; }
.review-row__body strong { color: #533d33; font-size: 11px; }
.review-row__body small { margin-top: 2px; color: #a18d83; font-size: 9px; }
.detail-banner { display: flex; align-items: flex-start; justify-content: space-between; padding: 10px 12px; border-radius: 8px; background: #f3f8f4; }
.detail-banner strong, .detail-banner span { display: block; }
.detail-banner strong { color: #3d5a4c; font-size: 12px; }
.detail-banner span { margin-top: 3px; color: #84988d; font-size: 10px; }
.detail-stale { margin: 10px 0; padding: 9px 11px; border-radius: 7px; background: #fdece3; color: #96411f; font-size: 11px; }
.detail-stale em { display: inline-block; margin: 0 4px; padding: 1px 9px; border-radius: 999px; background: #fff; font-style: normal; font-weight: 700; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
.frozen-label { display: flex; align-items: center; gap: 6px; color: #51708a; font-size: 11px; font-weight: 700; }
.frozen-label--live { color: #96523a; }
.frozen-card { border: 1px solid #eee6e1; border-radius: 8px; overflow: hidden; }
</style>
