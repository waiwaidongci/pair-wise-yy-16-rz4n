<script setup lang="ts">
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import { useFiringStore } from '../stores/firingStore'
import { parseTemperatureCsv, type BadRow } from '../utils/csv'

const store = useFiringStore()
const { activeSession, lastImportBadRows } = storeToRefs(store)
const fileInput = ref<HTMLInputElement>()
const importMessage = ref('')
const importError = ref('')
const lastImportCount = ref(0)

function openFile() {
  fileInput.value?.click()
}

async function importCsv(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  importError.value = ''
  importMessage.value = ''
  let content: string
  try {
    content = await file.text()
  } catch (error) {
    importError.value = `记录仪文件读取失败，已保留原数据：${error instanceof Error ? error.message : '未知错误'}`
    ;(event.target as HTMLInputElement).value = ''
    return
  }
  let parsed: ReturnType<typeof parseTemperatureCsv>
  try {
    parsed = parseTemperatureCsv(content)
  } catch (error) {
    importError.value = `记录仪文件解析异常，已保留原数据：${error instanceof Error ? error.message : '未知错误'}`
    ;(event.target as HTMLInputElement).value = ''
    return
  }
  if (!parsed.samples.length) {
    importError.value = `未解析到有效记录，原有 ${activeSession.value.actualSamples.length} 点实测数据已保留。请确认 CSV 包含 time,temp 两列。`
    store.lastImportBadRows.length = 0
  } else {
    store.importSamples(parsed.samples, parsed.badRows)
    lastImportCount.value = parsed.samples.length
    const quarantined = parsed.badRows.length
      ? `；${parsed.badRows.length} 行坏记录已隔离，可在下方查看`
      : ''
    importMessage.value = `已导入 ${parsed.samples.length} 个温度采样点${quarantined}。`
  }
  ;(event.target as HTMLInputElement).value = ''
}

function badRowsSummary(rows: BadRow[]) {
  return rows.slice(0, 5).map((row) => `第 ${row.line} 行：${row.reason}`).join('；')
}
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">窑次档案</span>
        <h2>窑次与记录仪数据</h2>
        <p>维护泥料、釉料和烧成参数，导入温度记录后自动进入待复核状态。</p>
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
          </div>
        </button>
      </article>

      <article class="session-detail">
        <div class="panel-title panel-title--row">
          <div><strong>{{ activeSession.name }}</strong><span>窑次信息与记录仪导入</span></div>
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
            <span>支持 time,temp 或 时间,温度 表头；时间单位可为分钟或 hh:mm:ss。异常行自动隔离，原数据保留可恢复。</span>
          </div>
          <Button label="选择文件" icon="pi pi-upload" outlined @click="openFile" />
          <Button v-if="activeSession.actualSamples.length" label="清除实测" severity="danger" text @click="store.clearActualSamples" />
        </div>
        <p v-if="importMessage" class="import-message">{{ importMessage }}</p>
        <p v-if="importError" class="import-message import-message--error">{{ importError }}</p>
        <div v-if="lastImportBadRows.length" class="bad-rows">
          <strong><i class="pi pi-exclamation-triangle" /> 坏记录已隔离（{{ lastImportBadRows.length }} 行，未写入实测数据）</strong>
          <span>{{ badRowsSummary(lastImportBadRows) }}<template v-if="lastImportBadRows.length > 5"> 等</template></span>
        </div>
        <div v-if="activeSession.sampleBackup?.samples.length" class="backup-bar">
          <div>
            <strong>导入前数据可恢复</strong>
            <span>{{ activeSession.sampleBackup.samples.length }} 点 · 保存于 {{ new Date(activeSession.sampleBackup.savedAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
          </div>
          <Button label="恢复导入前数据" icon="pi pi-undo" outlined size="small" @click="store.restoreSampleBackup" />
        </div>

        <div class="sample-summary">
          <strong>当前实测数据</strong>
          <span v-if="activeSession.actualSamples.length">
            {{ activeSession.actualSamples.length }} 点 · 起始 {{ activeSession.actualSamples[0].tempC.toFixed(0) }} ℃ · 结束 {{ activeSession.actualSamples.at(-1)?.tempC.toFixed(0) }} ℃
          </span>
          <span v-else>尚未导入实测温度</span>
        </div>
      </article>
    </section>
  </div>
</template>
