<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Tag from 'primevue/tag'
import { useFiringStore } from '../stores/firingStore'
import CurveChart from '../components/CurveChart.vue'
import { calculateDeviation } from '../utils/curve'
import { reviewState } from '../utils/review'

const store = useFiringStore()
const { visibleSessions, activeSession } = storeToRefs(store)
const comparisonRows = computed(() =>
  visibleSessions.value.map((session) => {
    const live = calculateDeviation(session.points, session.actualSamples, session.timeOffsetMin)
    const review = reviewState(session)
    const peak = Math.max(...session.points.map((point) => point.tempC))
    return {
      session,
      live,
      peak,
      reviewVersion: review.review?.version ?? null,
      reviewStale: review.stale,
      // 复核仍有效时展示冻结偏差，过期时展示实时重算值
      deviation: review.review && review.fresh ? review.review.deviation : live,
      deviationFrozen: Boolean(review.review && review.fresh),
    }
  }),
)
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">多窑次叠加</span>
        <h2>曲线对齐与偏差比较</h2>
        <p>统一按烧成经过时间对齐，虚线为记录仪实际温度。复核有效时展示冻结偏差，过期后自动切换实时重算。</p>
      </div>
      <Button label="返回编辑" icon="pi pi-pencil" outlined @click="$router.push('/editor')" />
    </section>

    <section class="compare-layout">
      <article class="compare-card">
        <CurveChart
          :sessions="visibleSessions"
          :active-session-id="activeSession.id"
          :interactive="false"
          :show-actual="true"
        />
      </article>
      <aside class="compare-side">
        <div class="panel-title">
          <strong>叠加窑次</strong>
          <span>最多可选择全部窑次</span>
        </div>
        <label
          v-for="session in store.sessions"
          :key="session.id"
          class="session-toggle"
          :class="{ 'session-toggle--active': session.id === activeSession.id }"
        >
          <Checkbox
            :model-value="session.id === activeSession.id || store.overlaySessionIds.includes(session.id)"
            binary
            :disabled="session.id === activeSession.id"
            @update:model-value="store.toggleOverlay(session.id)"
          />
          <span>
            <strong>{{ session.name }}</strong>
            <small>{{ session.clay }} / {{ session.glaze }}</small>
          </span>
          <Tag v-if="session.id === activeSession.id" value="当前" severity="danger" />
        </label>
      </aside>
    </section>

    <section class="content-card">
      <div class="panel-title panel-title--row">
        <div><strong>窑次对比明细</strong><span>偏差采用实际时间加时间偏移，与目标曲线同点插值</span></div>
      </div>
      <div class="comparison-table comparison-table--review">
        <div class="comparison-row comparison-row--header">
          <span>窑次</span><span>泥料 / 釉料</span><span>峰值</span><span>平均偏差</span><span>最大偏差</span><span>复核版本</span><span>状态</span>
        </div>
        <div v-for="row in comparisonRows" :key="row.session.id" class="comparison-row">
          <strong>{{ row.session.name }}</strong>
          <span>{{ row.session.clay }} / {{ row.session.glaze }}</span>
          <span>{{ row.peak }} ℃</span>
          <span>
            {{ row.deviation.meanAbs.toFixed(1) }} ℃
            <small class="source-tag">{{ row.deviationFrozen ? '冻结' : '实时' }}</small>
          </span>
          <span>
            {{ row.deviation.maxAbs.toFixed(1) }} ℃
            <small class="source-tag">{{ row.deviationFrozen ? '冻结' : '实时' }}</small>
          </span>
          <span>
            <template v-if="row.reviewVersion">
              <Tag value="已过期" severity="danger" v-if="row.reviewStale.length" />
              <Tag :value="`v${row.reviewVersion}`" severity="success" v-else />
            </template>
            <span v-else class="no-review">未发布</span>
          </span>
          <Tag :value="row.session.status === 'completed' ? '已完成' : row.session.status === 'review' ? '待复核' : '草稿'" :severity="row.session.status === 'completed' ? 'success' : row.session.status === 'review' ? 'warn' : 'secondary'" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.comparison-table--review .comparison-row { grid-template-columns: 1.3fr 1.1fr .6fr .9fr .9fr .8fr .7fr; }
.source-tag { display: inline-block; margin-left: 5px; padding: 0 6px; border-radius: 999px; background: #eef0ee; color: #7a8a84; font-size: 9px; }
.no-review { color: #b3a79f; font-size: 10px; }
</style>
