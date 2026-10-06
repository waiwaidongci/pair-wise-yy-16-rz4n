<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import Tag from 'primevue/tag'
import {
  STORAGE_KEY,
} from './utils/persistence'
import { useFiringStore } from './stores/firingStore'
import ConflictBanner from './components/ConflictBanner.vue'

const route = useRoute()
const router = useRouter()
const store = useFiringStore()
const { conflictNotices } = storeToRefs(store)
const navItems = [
  { path: '/editor', label: '曲线编辑', icon: 'pi pi-chart-line' },
  { path: '/compare', label: '窑次对比', icon: 'pi pi-chart-scatter' },
  { path: '/sessions', label: '窑次管理', icon: 'pi pi-database' },
  { path: '/templates', label: '曲线模板', icon: 'pi pi-copy' },
]
const activePath = computed(() => navItems.find((item) => route.path.startsWith(item.path))?.path ?? '/editor')
const activeLabel = computed(() => navItems.find((item) => item.path === activePath.value)?.label ?? '曲线编辑')

function onStorage(event: StorageEvent) {
  // 只关心共享业务数据（存储被整体清空时 key 为 null 也同步一次）；
  // 标签页自身偏好存于 sessionStorage，不会互相干扰
  if (event.key && event.key !== STORAGE_KEY) return
  store.handleStorageEvent()
}

onMounted(() => window.addEventListener('storage', onStorage))
onBeforeUnmount(() => window.removeEventListener('storage', onStorage))
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
          <span>目标曲线与记录仪数据自动保存 · {{ store.clientLabel }}</span>
        </div>
      </header>
      <main class="app-content">
        <ConflictBanner :notices="conflictNotices" />
        <RouterView />
      </main>
    </section>
  </div>
</template>
