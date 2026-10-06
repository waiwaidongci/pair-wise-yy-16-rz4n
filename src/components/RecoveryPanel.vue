<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import { storeToRefs } from 'pinia'
import { useFiringStore } from '../stores/firingStore'
import { downloadText } from '../utils/csv'

const props = defineProps<{
  sessionId: string
}>()

const store = useFiringStore()
const { quarantine, activeBackups } = storeToRefs(store)

const sessionQuarantine = computed(() =>
  quarantine.value.filter((item) => item.sessionId === props.sessionId || item.kind !== 'csv-rows'),
)

const kindLabel: Record<string, string> = {
  'storage-raw': '损坏的本地存储',
  'session-record': '损坏的窑次记录',
  'template-record': '损坏的模板记录',
  'csv-rows': '记录仪坏行 / 坏文件',
}

function formatTime(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

function backupSummary(samples: Array<{ tempC: number }>) {
  if (!samples.length) return '空数据'
  return `${samples.length} 点 · 起始 ${samples[0].tempC.toFixed(0)}℃`
}

function downloadItem(id: string) {
  const item = quarantine.value.find((entry) => entry.id === id)
  if (!item) return
  const content = item.rawText ?? [item.reason, ...(item.badRows ?? [])].join('\n')
  const suffix = item.kind === 'csv-rows' ? 'csv' : 'json'
  downloadText(content, `隔离记录-${item.id.slice(0, 8)}.${suffix}`, 'text/plain;charset=utf-8')
}
</script>

<template>
  <div class="recovery">
    <section v-if="activeBackups.length" class="recovery-block">
      <div class="panel-title">
        <strong>实测数据备份</strong>
        <span>导入新记录或清除前自动保留最近 {{ 3 }} 份，恢复时当前数据会先进入备份</span>
      </div>
      <div class="backup-list">
        <div v-for="backup in activeBackups" :key="backup.id" class="backup-row">
          <span class="backup-dot"><i class="pi pi-history" /></span>
          <span class="backup-body">
            <strong>{{ backup.reason === 'import-failed' ? '导入失败时保留' : '替换前自动备份' }}</strong>
            <small>{{ formatTime(backup.createdAt) }} · {{ backupSummary(backup.samples) }}</small>
          </span>
          <Button label="恢复" size="small" outlined @click="store.restoreBackup(backup.id)" />
          <Button icon="pi pi-times" size="small" severity="secondary" text @click="store.discardBackup(backup.id)" />
        </div>
      </div>
    </section>

    <section v-if="sessionQuarantine.length" class="recovery-block">
      <div class="panel-title panel-title--row">
        <div>
          <strong>隔离的坏记录</strong>
          <span>坏数据不会覆盖原有内容，可随时下载核对或移除</span>
        </div>
        <Button label="全部清除" size="small" severity="secondary" text @click="store.clearQuarantine()" />
      </div>
      <div class="quarantine-list">
        <article v-for="item in sessionQuarantine" :key="item.id" class="quarantine-row">
          <div class="quarantine-row__head">
            <Tag :value="kindLabel[item.kind] ?? item.kind" severity="warn" />
            <small>{{ formatTime(item.createdAt) }}</small>
          </div>
          <p>{{ item.reason }}</p>
          <div v-if="item.badRows?.length" class="bad-rows">
            <span>异常行示例（共 {{ item.badRows.length }} 行）：</span>
            <code v-for="(row, index) in item.badRows.slice(0, 3)" :key="index">{{ row }}</code>
          </div>
          <div class="quarantine-row__actions">
            <Button v-if="item.rawText" label="下载原始内容" size="small" outlined icon="pi pi-download" @click="downloadItem(item.id)" />
            <Button label="移除" size="small" severity="danger" text icon="pi pi-trash" @click="store.removeQuarantine(item.id)" />
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.recovery { display: grid; gap: 14px; }
.recovery-block { overflow: hidden; border: 1px solid #e5dcd5; border-radius: 10px; background: #fff; box-shadow: 0 10px 28px rgba(73, 46, 35, .05); }
.backup-list, .quarantine-list { padding: 6px 12px 12px; }
.backup-row { display: flex; align-items: center; gap: 10px; padding: 9px 4px; border-bottom: 1px solid #f2ece8; }
.backup-dot { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 7px; background: #e6f0ec; color: #3f7565; }
.backup-body { flex: 1; }
.backup-body strong, .backup-body small { display: block; }
.backup-body strong { color: #4c5f58; font-size: 11px; }
.backup-body small { margin-top: 2px; color: #98a39d; font-size: 9px; }
.quarantine-row { margin-top: 9px; padding: 11px 12px; border: 1px solid #eddbb2; border-radius: 8px; background: #fffaef; }
.quarantine-row__head { display: flex; align-items: center; justify-content: space-between; }
.quarantine-row__head small { color: #b09b74; font-size: 9px; }
.quarantine-row p { margin: 8px 0 0; color: #806844; font-size: 10px; line-height: 1.7; }
.bad-rows { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; color: #a08658; font-size: 9px; }
.bad-rows code { padding: 2px 7px; border-radius: 5px; background: #fff; color: #946f33; font-family: Menlo, monospace; }
.quarantine-row__actions { display: flex; gap: 8px; margin-top: 9px; }
</style>
