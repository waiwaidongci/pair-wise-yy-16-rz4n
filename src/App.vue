<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Dialog from 'primevue/dialog'
import { useFiringStore } from './stores/firingStore'

const route = useRoute()
const router = useRouter()
const store = useFiringStore()
const { quarantined, externalUpdate } = storeToRefs(store)
const quarantineOpen = ref(false)
const navItems = [
  { path: '/editor', label: '曲线编辑', icon: 'pi pi-chart-line' },
  { path: '/compare', label: '窑次对比', icon: 'pi pi-chart-scatter' },
  { path: '/sessions', label: '窑次管理', icon: 'pi pi-database' },
  { path: '/templates', label: '曲线模板', icon: 'pi pi-copy' },
]
const activePath = computed(() => navItems.find((item) => route.path.startsWith(item.path))?.path ?? '/editor')
const activeLabel = computed(() => navItems.find((item) => item.path === activePath.value)?.label ?? '曲线编辑')
const quarantineSummary = computed(() => {
  const sessions = quarantined.value.filter((record) => record.kind === 'session').length
  const templates = quarantined.value.filter((record) => record.kind === 'template').length
  return [sessions && `窑次 ${sessions} 条`, templates && `模板 ${templates} 条`].filter(Boolean).join('，')
})

function formatRaw(raw: unknown) {
  if (raw === null) return '（整体解析失败，无原始内容）'
  try {
    return JSON.stringify(raw).slice(0, 160)
  } catch {
    return '（无法序列化的损坏记录）'
  }
}
</script>

<template>
  <div class="app-shell">
    <aside class="app-sider">
      <div class="brand">
        <div class="brand__mark">火</div>
        <div>
          <strong>火候</strong>
          <span>KILN FIRING STUDIO</span>
        </div>
      </div>
      <nav class="app-nav">
        <button
          v-for="item in navItems"
          :key="item.path"
          type="button"
          class="nav-item"
          :class="{ 'nav-item--active': activePath === item.path }"
          @click="router.push(item.path)"
        >
          <i :class="item.icon" />
          <span>{{ item.label }}</span>
        </button>
      </nav>
      <div class="kiln-card">
        <i class="pi pi-sun" />
        <div>
          <strong>气窑 3 号 · 正常</strong>
          <span>热电偶 K 型 / 5 秒采样</span>
        </div>
      </div>
      <div class="sider-footer">
        <span>工艺标准 v2.4</span>
        <Tag value="本地" severity="success" />
      </div>
    </aside>
    <section class="app-workspace">
      <header class="app-header">
        <div>
          <span>陶艺烧成数字工作台</span>
          <strong>{{ activeLabel }}</strong>
        </div>
        <div class="header-actions">
          <span class="sync-dot" />
          <span>目标曲线与记录仪数据自动保存</span>
        </div>
      </header>
      <div class="app-banners">
        <div v-if="externalUpdate" class="banner banner--info">
          <i class="pi pi-info-circle" />
          <span>其他标签页已保存更新，重新加载可查看最新窑次与复核版本，避免覆盖彼此的修改。</span>
          <Button label="重新加载" size="small" outlined @click="store.reloadFromStorage" />
        </div>
        <div v-if="quarantined.length" class="banner banner--warn">
          <i class="pi pi-exclamation-triangle" />
          <span>检测到 {{ quarantined.length }} 条无法读取的损坏记录（{{ quarantineSummary }}），已隔离且未影响现有数据。</span>
          <Button label="查看" size="small" text @click="quarantineOpen = true" />
          <Button label="清除" size="small" text @click="store.clearQuarantine" />
        </div>
      </div>
      <main class="app-content">
        <RouterView />
      </main>
    </section>

    <Dialog v-model:visible="quarantineOpen" header="损坏记录隔离区" :style="{ width: '620px' }" modal>
      <p class="quarantine-lead">
        以下记录来自本地存档，因缺少必要字段或格式损坏无法加载。它们已被隔离，不会进入窑次与模板列表，可在此查看原始内容后清除。
      </p>
      <div class="quarantine-list">
        <article v-for="record in quarantined" :key="record.id" class="quarantine-item">
          <div class="quarantine-item__top">
            <Tag :value="record.kind === 'session' ? '窑次' : '模板'" :severity="record.kind === 'session' ? 'warn' : 'info'" />
            <strong>{{ record.id }}</strong>
            <span>{{ new Date(record.foundAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
          </div>
          <p>{{ record.reason }}</p>
          <code>{{ formatRaw(record.raw) }}</code>
        </article>
      </div>
      <template #footer>
        <Button label="关闭" severity="secondary" text @click="quarantineOpen = false" />
        <Button label="全部清除" icon="pi pi-trash" severity="danger" outlined @click="store.clearQuarantine(); quarantineOpen = false" />
      </template>
    </Dialog>
  </div>
</template>
