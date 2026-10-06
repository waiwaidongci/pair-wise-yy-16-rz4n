<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import { useFiringStore } from '../stores/firingStore'
import { parseTemperatureCsv } from '../utils/csv'
import RecoveryPanel from '../components/RecoveryPanel.vue'

const store = useFiringStore()
const { activeSession } = storeToRefs(store)
const fileInput = ref<HTMLInputElement>()
const importMessage = ref<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null)
const sessionQuarantineCount = computed(
  () => store.quarantine.filter((item) => item.sessionId === activeSession.value.id).length,
)

function openFile() {
  fileInput.value?.click()
}

async function importCsv(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const rawText = await file.text()
  const hadSamples = activeSession.value.actualSamples.length > 0
  const result = parseTemperatureCsv(rawText)

  if (!result.samples.length) {
    // 整文件无法使用：不动当前实测，原文+坏行进入隔离，可下载重试
    store.quarantineCsvFile(
      rawText,
      result.reason
        ? `${activeSession.value.name}：${result.reason} 现有 ${hadSamples ? activeSession.value.actualSamples.length : 0} 个实测点保持不变。`
        : '未解析到有效记录，现有实测数据保持不变。',
      result.badRows,
    )
    importMessage.value = {
      tone: 'error',
      text: `未导入任何记录${result.badRows.length ? `，${result.badRows.length} 行已隔离` : ''}；${hadSamples ? '原实测数据未改动，' : ''}可在下方隔离区下载原始文件核对。`,
    }
  } else {
    store.importSamples(result.samples, result.badRows, rawText, result.reason)
    importMessage.value = result.badRows.length
      ? {
          tone: 'warn',
          text: `已导入 ${result.samples.length} 个采样点，${result.badRows.length} 行异常记录已隔离；${hadSamples ? '替换前的实测数据已自动备份，可恢复。' : ''}`,
        }
      : {
          tone: 'ok',
          text: `已导入 ${result.samples.length} 个温度采样点。${hadSamples ? '替换前的实测数据已自动备份，可恢复。' : ''}`,
        }
  }
  input.value = ''
}
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">窑次档案</span>
        <h2>
          窑次与记录仪数据
          <Tag v-if="store.quarantineCount" :value="`${store.quarantineCount} 条隔离记录`" severity="warn" style="margin-left: 10px; vertical-align: middle" />
        </h2>
        <p>维护泥料、釉料和烧成参数，导入温度记录后自动进入待复核状态；异常文件不会覆盖原数据。</p>
      </div>
      <Button label="新建窑次" icon="pi pi-plus" @click="store.addSession" />
    </section>

    <section class="sessions-grid">
      <article class="session-list-card">
        <div class="panel-title panel-title--row">
          <div><strong>全部窑次</strong><span>{{ store.sessions.length }} 条记录</span></div>
        </div>
        <button
          v-for="session in store.sessions"
          :key="session.id"
          type="button"
          class="session-card"
          :class="{ 'session-card--active': session.id === activeSession.id }"
          @click="store.setActiveSession(session.id)"
        >
          <div class="session-card__top">
            <strong>{{ session.name }}</strong>
            <Tag :value="session.status === 'completed' ? '已完成' : session.status === 'review' ? '待复核' : '草稿'" :severity="session.status === 'completed' ? 'success' : session.status === 'review' ? 'warn' : 'secondary'" />
          </div>
          <span>{{ session.kiln }} · {{ session.firedAt }}</span>
          <div class="session-card__meta">
            <span>{{ session.points.length }} 个目标关键点</span>
            <span>{{ session.actualSamples.length }} 个实测点</span>
            <span v-if="session.reviews.length">复核 v{{ session.reviews.at(-1)?.version }}</span>
          </div>
        </button>
      </article>

      <article class="session-detail">
        <div class="panel-title panel-title--row">
          <div><strong>{{ activeSession.name }}</strong><span>窑次信息与记录仪导入 · 修订 r{{ activeSession.revision }}</span></div>
          <Button icon="pi pi-trash" label="删除" severity="danger" text :disabled="store.sessions.length <= 1" @click="store.removeSession(activeSession.id)" />
        </div>
        <div class="form-grid">
          <label><span>窑次名称</span><InputText :model-value="activeSession.name" @update:model-value="store.updateSessionMeta({ name: $event })" /></label>
          <label><span>窑炉</span><InputText :model-value="activeSession.kiln" @update:model-value="store.updateSessionMeta({ kiln: $event })" /></label>
          <label><span>泥料</span>
            <Select
              :model-value="activeSession.clay"
              :options="['青瓷泥', '高白泥', '粗陶泥', '紫砂泥', '炻器泥']"
              @update:model-value="store.updateSessionMeta({ clay: $event })"
            />
          </label>
          <label><span>釉料</span>
            <Select
              :model-value="activeSession.glaze"
              :options="['天青釉', '月白釉', '柴烧落灰釉', '结晶釉', '乐烧釉']"
              @update:model-value="store.updateSessionMeta({ glaze: $event })"
            />
          </label>
          <label class="form-span"><span>烧成时间</span><InputText :model-value="activeSession.firedAt" @update:model-value="store.updateSessionMeta({ firedAt: $event })" /></label>
        </div>

        <div class="import-box">
          <input ref="fileInput" class="hidden-input" type="file" accept=".csv,text/csv" @change="importCsv" />
          <div class="import-icon"><i class="pi pi-file-import" /></div>
          <div>
            <strong>导入记录仪 CSV</strong>
            <span>支持 time,temp 或 时间,温度 表头；时间单位可为分钟或 hh:mm:ss。坏行会被隔离而不是中断导入。</span>
          </div>
          <Button label="选择文件" icon="pi pi-upload" outlined @click="openFile" />
          <Button v-if="activeSession.actualSamples.length" label="清除实测" severity="danger" text @click="store.clearActualSamples" />
        </div>
        <p v-if="importMessage" class="import-message" :class="`import-message--${importMessage.tone}`">{{ importMessage.text }}</p>

        <div class="sample-summary">
          <strong>当前实测数据</strong>
          <span v-if="activeSession.actualSamples.length">
            {{ activeSession.actualSamples.length }} 点 · 起始 {{ activeSession.actualSamples[0].tempC.toFixed(0) }} ℃ · 结束 {{ activeSession.actualSamples.at(-1)?.tempC.toFixed(0) }} ℃
          </span>
          <span v-else>尚未导入实测温度</span>
          <Tag v-if="sessionQuarantineCount" :value="`本窑次 ${sessionQuarantineCount} 条隔离`" severity="warn" />
        </div>
      </article>
    </section>

    <RecoveryPanel :session-id="activeSession.id" />
  </div>
</template>

<style scoped>
.import-message { margin: 10px 16px 0; padding: 9px 11px; border-radius: 6px; font-size: 10px; line-height: 1.7; }
.import-message--ok { background: #eef5f2; color: #4f7669; }
.import-message--warn { background: #fdf6e7; color: #8a641c; }
.import-message--error { background: #fdecea; color: #a44733; }
</style>
