<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import type { ConflictNotice } from '../types/firing'
import { useFiringStore } from '../stores/firingStore'

const props = defineProps<{
  notices: ConflictNotice[]
}>()

const store = useFiringStore()
const current = computed(() => props.notices[0] ?? null)
const moreCount = computed(() => Math.max(0, props.notices.length - 1))

function formatTime(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString('zh-CN', { hour12: false })
}
</script>

<template>
  <div v-if="current" class="conflict-banner">
    <div class="conflict-icon"><i :class="current.reason === 'deleted' ? 'pi pi-trash' : 'pi pi-clone'" /></div>
    <div class="conflict-body">
      <strong>
        {{ current.reason === 'deleted' ? `另一标签页删除了「${current.sessionName}」` : `「${current.sessionName}」在另一标签页被修改` }}
        <small>{{ current.clientLabel }} · {{ formatTime(current.at) }}</small>
        <em v-if="moreCount">另有 {{ moreCount }} 个未处理项</em>
      </strong>
      <p v-if="current.reason === 'deleted'">
        本标签页上的未提交修改已完整保留。恢复后将作为新版本写回，不会覆盖对方删除后产生的复核记录。
      </p>
      <div v-else class="conflict-fields">
        <span>以下项目与对方保存的内容不同，本页修改未被覆盖：</span>
        <div v-for="field in current.fields" :key="field.field" class="conflict-field">
          <label>{{ field.label }}</label>
          <span class="conflict-value conflict-value--remote"><i>对方已保存</i>{{ field.remoteValue }}</span>
          <span class="conflict-value conflict-value--local"><i>本页未提交</i>{{ field.localValue }}</span>
        </div>
      </div>
    </div>
    <div class="conflict-actions">
      <Button
        icon="pi pi-undo"
        :label="current.reason === 'deleted' ? '恢复我的窑次' : '保留我的修改'"
        size="small"
        severity="warning"
        @click="store.keepStashedChanges(current.sessionId)"
      />
      <Button
        icon="pi pi-check"
        label="采用对方版本"
        size="small"
        severity="secondary"
        text
        @click="store.dismissConflict(true, current.sessionId)"
      />
    </div>
  </div>
</template>

<style scoped>
.conflict-banner {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
  padding: 12px 15px;
  border: 1px solid #e6b9a4;
  border-left: 4px solid #c4552f;
  border-radius: 9px;
  background: linear-gradient(90deg, #fff4ed, #fffaf7);
  box-shadow: 0 8px 22px rgba(162, 77, 38, .1);
}
.conflict-icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  place-items: center;
  border-radius: 9px;
  background: #f3d6c6;
  color: #b04c2a;
  font-size: 17px;
}
.conflict-body { flex: 1; min-width: 0; }
.conflict-body strong { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; color: #8e3f25; font-size: 13px; }
.conflict-body strong small { color: #b08d7e; font-size: 10px; font-weight: 400; }
.conflict-body strong em { padding: 1px 8px; border-radius: 999px; background: #f7e0d2; color: #a4482b; font-size: 10px; font-style: normal; }
.conflict-body p { margin: 5px 0 0; color: #916b58; font-size: 11px; }
.conflict-fields { margin-top: 6px; color: #9a7765; font-size: 10px; }
.conflict-field { display: grid; gap: 6px; margin-top: 6px; grid-template-columns: 110px 1fr 1fr; align-items: start; }
.conflict-field label { color: #7c5645; font-weight: 700; }
.conflict-value { display: flex; flex-direction: column; gap: 2px; padding: 6px 9px; border-radius: 6px; font-size: 10px; }
.conflict-value i { font-style: normal; font-size: 9px; opacity: .75; }
.conflict-value--remote { background: #eef3f1; color: #43615b; }
.conflict-value--local { background: #fdeee7; color: #93462b; }
.conflict-actions { display: flex; flex-direction: column; gap: 6px; justify-content: center; }
</style>
