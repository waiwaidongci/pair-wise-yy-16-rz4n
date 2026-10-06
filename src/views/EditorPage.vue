<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import Select from 'primevue/select'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Tag from 'primevue/tag'
import { useFiringStore } from '../stores/firingStore'
import CurveChart from '../components/CurveChart.vue'
import StagePanel from '../components/StagePanel.vue'
import RiskSummary from '../components/RiskSummary.vue'
import DeviationPanel from '../components/DeviationPanel.vue'
import ReviewCenter from '../components/ReviewCenter.vue'
import { buildStages, calculateDeviation } from '../utils/curve'
import { STALE_FIELD_LABELS } from '../utils/review'

const store = useFiringStore()
const { activeSession, selectedPointId, selectedStageIndex, validationIssues, canUndo, canRedo, activeReview, clientLabel } =
  storeToRefs(store)
const templateOpen = ref(false)
const templateName = ref('')
const publishOpen = ref(false)
const publishNote = ref('')
const publishConflict = ref(false)
const publishMessage = ref('')
const stages = computed(() => buildStages(activeSession.value.points))
const deviation = computed(() =>
  calculateDeviation(
    activeSession.value.points,
    activeSession.value.actualSamples,
    activeSession.value.timeOffsetMin,
  ),
)
const sessionOptions = computed(() =>
  store.sessions.map((session) => ({ label: session.name, value: session.id })),
)

function updateSelectedStage(index: number, field: 'duration' | 'targetTemp', value: number) {
  const stage = stages.value[index]
  if (!stage) return
  if (field === 'duration') {
    store.updatePoint(stage.end.id, stage.start.timeMin + Math.max(1, value), stage.end.tempC)
  } else {
    store.updatePoint(stage.end.id, stage.end.timeMin, value)
  }
  selectedStageIndex.value = index
}

function saveTemplate() {
  store.saveTemplateFromSession(templateName.value)
  templateOpen.value = false
  templateName.value = ''
}

function requestPublish() {
  publishMessage.value = ''
  publishConflict.value = false
  if (!activeSession.value.actualSamples.length) {
    publishMessage.value = '没有实测采样，无法发布复核。'
    return
  }
  publishNote.value = ''
  publishOpen.value = true
}

function confirmPublish() {
  const result = store.publishReview(publishNote.value.trim() || undefined)
  if (result.ok) {
    publishOpen.value = false
    publishMessage.value = `已发布复核 v${result.review.version}，曲线、偏移、采样与风险结果已冻结。`
    return
  }
  if (result.reason === 'no-samples') {
    publishMessage.value = '没有实测采样，无法发布复核。'
    publishOpen.value = false
    return
  }
  // 冲突：列出过期项，本页未提交内容已保留在顶部横幅中
  publishOpen.value = false
  publishConflict.value = true
}

function publishWithStashed() {
  const result = store.publishReview(publishNote.value.trim() || undefined, { useStashed: true })
  publishConflict.value = false
  if (result.ok) {
    publishMessage.value = `已按本页未提交内容发布复核 v${result.review.version}，对方的复核历史已保留。`
  }
}

function publishWithRemote() {
  // 放弃本页未提交内容，以协调后工作区中的对方版本为基线冻结
  const notice = store.conflictNotice
  if (notice) store.dismissConflict(true, notice.sessionId)
  const result = store.publishReview(publishNote.value.trim() || undefined)
  publishConflict.value = false
  if (result.ok) {
    publishMessage.value = `已按另一标签页保存的内容发布复核 v${result.review.version}。`
  }
}
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">当前窑次</span>
        <h2>
          {{ activeSession.name }}
          <Tag
            v-if="activeReview.review && activeReview.stale.length"
            value="复核已过期"
            severity="danger"
            style="margin-left: 10px; vertical-align: middle"
          />
        </h2>
        <p>{{ activeSession.kiln }} · {{ activeSession.clay }} / {{ activeSession.glaze }} · {{ activeSession.firedAt }}</p>
      </div>
      <div class="heading-actions">
        <Select
          :model-value="store.activeSessionId"
          :options="sessionOptions"
          option-label="label"
          option-value="value"
          class="session-select"
          @update:model-value="store.setActiveSession"
        />
        <Button icon="pi pi-undo" label="撤销" severity="secondary" outlined :disabled="!canUndo" @click="store.undo" />
        <Button icon="pi pi-redo" label="重做" severity="secondary" outlined :disabled="!canRedo" @click="store.redo" />
        <Button icon="pi pi-verified" label="发布复核" severity="warn" outlined @click="requestPublish" />
        <Button icon="pi pi-copy" label="保存模板" outlined @click="templateOpen = true" />
        <Button icon="pi pi-download" label="导出 JSON" @click="store.exportSessionJson" />
      </div>
    </section>

    <p v-if="publishMessage" class="publish-message">{{ publishMessage }}</p>

    <section class="editor-grid">
      <article class="chart-card">
        <div class="chart-toolbar">
          <div>
            <strong>目标烧成曲线</strong>
            <span>拖动关键点可同时调整温度与到达时间；改动曲线会使已发布复核立即过期</span>
          </div>
          <div class="chart-metrics">
            <span>关键点 <strong>{{ activeSession.points.length }}</strong></span>
            <span>阶段 <strong>{{ stages.length }}</strong></span>
            <span>峰值 <strong>{{ Math.max(...activeSession.points.map((point) => point.tempC)) }} ℃</strong></span>
            <span>修订 <strong>r{{ activeSession.revision }}</strong></span>
          </div>
        </div>
        <CurveChart
          :sessions="[activeSession]"
          :active-session-id="activeSession.id"
          :selected-point-id="selectedPointId"
          @select-point="selectedPointId = $event"
          @update-point="(id, time, temp) => store.updatePoint(id, time, temp, false)"
          @begin-drag="store.beginDrag"
          @end-drag="store.endDrag"
        />
      </article>

      <aside class="side-panel">
        <StagePanel
          :stages="stages"
          :issues="validationIssues"
          :selected-index="selectedStageIndex"
          @select="selectedStageIndex = $event"
          @update="updateSelectedStage"
          @add-after="store.addPointAfterStage"
        />
      </aside>
    </section>

    <section class="review-grid">
      <ReviewCenter
        :session="activeSession"
        :stale-fields="activeReview.stale"
        :client-label="clientLabel"
        @publish="requestPublish"
      />
    </section>

    <section class="lower-grid">
      <article class="detail-card">
        <div class="live-banner">
          <i class="pi pi-bolt" />
          <span v-if="activeReview.review && activeReview.stale.length">
            复核 v{{ activeReview.review.version }} 已过期，以下为按最新数据重新计算的实时偏差
            <em v-for="field in activeReview.stale" :key="field">{{ STALE_FIELD_LABELS[field] }}</em>
          </span>
          <span v-else>实时偏差（未冻结；发布复核后此处仍跟随当前数据）</span>
        </div>
        <DeviationPanel
          :summary="deviation"
          :offset-min="activeSession.timeOffsetMin"
          @update-offset="store.setTimeOffset"
        />
      </article>
      <article class="detail-card">
        <div class="live-banner">
          <i class="pi pi-bolt" />
          <span v-if="activeReview.review && activeReview.stale.length">
            旧复核的风险判断已随
            <em v-for="field in activeReview.stale.filter((f) => f === 'points' || f === 'materials' || f === 'risk')" :key="field">{{ STALE_FIELD_LABELS[field] }}</em>
            失效，以下为最新规则结果
          </span>
          <span v-else>实时釉面风险检查</span>
        </div>
        <RiskSummary :issues="validationIssues" />
      </article>
    </section>

    <Dialog v-model:visible="publishOpen" header="发布烧成复核" :style="{ width: '500px' }" modal>
      <div class="publish-body">
        <p class="publish-hint">
          <i class="pi pi-snowflake" />
          发布将冻结当前窑次的目标曲线、时间偏移（{{ activeSession.timeOffsetMin }} min）、
          {{ activeSession.actualSamples.length }} 个实测采样、偏差统计与风险判断。
        </p>
        <div v-if="activeReview.review" class="publish-renew">
          <template v-if="activeReview.stale.length">
            上一版 v{{ activeReview.review.version }} 将标记为历史版本，过期项：
            <em v-for="field in activeReview.stale" :key="field">{{ STALE_FIELD_LABELS[field] }}</em>
          </template>
          <template v-else>
            自 v{{ activeReview.review.version }} 以来冻结内容未发生变化，将创建一份相同基线的新版本。
          </template>
        </div>
        <label class="dialog-field">
          复核备注（可选）
          <Textarea v-model="publishNote" rows="3" placeholder="例如：降温段偏慢 8 分钟，釉面无异常，判定合格。" />
        </label>
      </div>
      <template #footer>
        <Button label="取消" severity="secondary" text @click="publishOpen = false" />
        <Button label="确认冻结发布" icon="pi pi-verified" severity="warn" @click="confirmPublish" />
      </template>
    </Dialog>

    <Dialog v-model:visible="publishConflict" header="检测到另一标签页已保存该窑次" :style="{ width: '640px' }" modal @update:model-value="publishConflict = $event">
      <div class="publish-conflict">
        <i class="pi pi-exclamation-triangle" />
        <div class="publish-conflict__body">
          <p>发布前检测到另一标签页对同一窑次的保存更新。冻结发布前请选择基线，任一冻结项的差异都会被保留并标记：</p>
          <div v-if="store.conflictNotice?.reason === 'updated' && store.conflictNotice.fields.length" class="publish-conflict__fields">
            <div v-for="field in store.conflictNotice.fields" :key="field.field" class="publish-conflict__field">
              <label>{{ field.label }}</label>
              <span class="pc-remote"><i>对方已保存</i>{{ field.remoteValue }}</span>
              <span class="pc-local"><i>本页未提交</i>{{ field.localValue }}</span>
            </div>
          </div>
          <p v-else-if="store.conflictNotice?.reason === 'deleted'" class="publish-conflict__deleted">
            另一标签页已删除该窑次，本页内容已保留。选择「用我的内容发布」将恢复窑次并发布；选择「取消」可在顶部横幅单独处理。
          </p>
        </div>
      </div>
      <template #footer>
        <Button label="取消" severity="secondary" text @click="publishConflict = false" />
        <Button label="用对方版本发布" severity="secondary" outlined @click="publishWithRemote" />
        <Button label="用我的内容发布" icon="pi pi-verified" severity="warn" @click="publishWithStashed" />
      </template>
    </Dialog>

    <Dialog v-model:visible="templateOpen" header="从当前窑次保存模板" :style="{ width: '460px' }" modal>
      <div class="dialog-field">
        <label>模板名称</label>
        <InputText v-model="templateName" placeholder="例如：天青釉 1260 慢烧" />
      </div>
      <template #footer>
        <Button label="取消" severity="secondary" text @click="templateOpen = false" />
        <Button label="保存模板" @click="saveTemplate" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.publish-message { margin: 0; padding: 9px 12px; border-radius: 7px; background: #eef5f2; color: #4f7669; font-size: 11px; }
.review-grid { display: grid; }
.live-banner { display: flex; align-items: center; gap: 8px; padding: 10px 16px 0; color: #9a6a4c; font-size: 10px; }
.live-banner i { font-size: 12px; }
.live-banner em { font-style: normal; margin: 0 3px; padding: 1px 7px; border-radius: 999px; background: #fdece3; color: #96411f; font-weight: 700; }
.publish-body { display: grid; gap: 14px; }
.publish-hint { display: flex; gap: 10px; margin: 0; padding: 12px; border-radius: 8px; background: #f1f6f4; color: #4a6f64; font-size: 12px; line-height: 1.8; }
.publish-hint i { color: #4b8375; }
.publish-renew { padding: 11px 12px; border: 1px solid #eed5c6; border-radius: 8px; background: #fff8f3; color: #91513a; font-size: 11px; line-height: 1.9; }
.publish-renew em { font-style: normal; margin: 0 3px; padding: 1px 8px; border-radius: 999px; background: #fff; font-weight: 700; }
.publish-conflict { display: flex; gap: 12px; }
.publish-conflict > i { font-size: 22px; color: #c77b2f; }
.publish-conflict p { margin: 0 0 9px; color: #7c6354; font-size: 12px; line-height: 1.8; }
.publish-conflict__fields { display: grid; gap: 7px; margin-top: 4px; }
.publish-conflict__field { display: grid; gap: 6px; grid-template-columns: 96px 1fr 1fr; align-items: start; }
.publish-conflict__field label { padding-top: 6px; color: #7c5645; font-size: 11px; font-weight: 700; }
.publish-conflict__field span { display: flex; flex-direction: column; gap: 2px; padding: 6px 9px; border-radius: 6px; font-size: 10px; line-height: 1.5; }
.publish-conflict__field span i { font-style: normal; font-size: 9px; opacity: .75; }
.publish-conflict__field .pc-remote { background: #eef3f1; color: #43615b; }
.publish-conflict__field .pc-local { background: #fdeee7; color: #93462b; }
.publish-conflict__deleted { color: #91513a !important; }
</style>
