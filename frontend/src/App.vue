<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { useCatalogStore } from "@/stores/catalog";
import { useNotificationStore } from "@/stores/notifications";
import { useOfflineStore } from "@/offline/store";
import MergeConflictDialog from "@/components/MergeConflictDialog.vue";

const auth = useAuthStore();
const catalog = useCatalogStore();
const notifications = useNotificationStore();
const offline = useOfflineStore();
const route = useRoute();
const router = useRouter();

const isMapPage = computed(() => route.name === "map");

onMounted(async () => {
  await offline.hydrate();
  offline.startNetworkWatch();
  await catalog.load().catch(() => undefined);

  if (auth.isLoggedIn) {
    await notifications.load().catch(() => undefined);
    // 页面可能是在断网期间关闭的：重新打开且在线时自动补传
    await offline.drainOutbox().catch(() => undefined);
  }
});

async function handleLogout() {
  await auth.logout();
  notifications.reset();
  ElMessage.success("已退出登录");
  router.push({ name: "map" });
}

async function goNotifications() {
  await router.push({ name: "notifications" });
}

async function flushNow() {
  await offline.drainOutbox();
  if (offline.conflictCount > 0) {
    ElMessage.warning("有内容需要在弹窗里确认合并结果");
  }
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <RouterLink to="/" class="app-brand">
        <span class="app-brand__dot" />
        公共空间细节地图
      </RouterLink>

      <nav class="app-nav">
        <RouterLink to="/">地图</RouterLink>
        <template v-if="auth.isLoggedIn">
          <RouterLink to="/me">我的记录</RouterLink>
        </template>
        <template v-if="auth.isModerator">
          <RouterLink to="/review">审核台</RouterLink>
          <RouterLink to="/reports">举报处置</RouterLink>
        </template>
        <template v-if="auth.isAdmin">
          <RouterLink to="/admin">管理后台</RouterLink>
        </template>
      </nav>

      <div class="app-actions">
        <!-- 离线 / 补传状态：点击立即补传，冲突时提示去确认 -->
        <el-tooltip
          v-if="!offline.online"
          content="当前离线，修改会保存在本机，联网后自动补传"
          placement="bottom"
        >
          <el-tag type="warning" effect="dark" class="app-offline-tag">离线</el-tag>
        </el-tooltip>
        <el-tooltip
          v-else-if="offline.pendingCount > 0"
          :content="`${offline.pendingCount} 条内容待补传，点击立即同步`"
          placement="bottom"
        >
          <el-tag type="info" effect="plain" class="app-offline-tag app-offline-tag--action" @click="flushNow">
            待补传 {{ offline.pendingCount }}
          </el-tag>
        </el-tooltip>
        <el-tooltip
          v-else-if="offline.conflictCount > 0"
          content="多端修改存在冲突，请在弹窗中确认最终结果"
          placement="bottom"
        >
          <el-tag type="danger" effect="dark" class="app-offline-tag">待合并</el-tag>
        </el-tooltip>

        <template v-if="auth.isLoggedIn">
          <el-badge :value="notifications.unread" :hidden="!notifications.hasUnread" :max="99">
            <el-button text circle aria-label="通知" @click="goNotifications">
              <el-icon><Bell /></el-icon>
            </el-button>
          </el-badge>

          <el-dropdown>
            <span class="app-user">
              {{ auth.user?.nickname }}
              <el-tag v-if="auth.isMuted" size="small" type="warning">禁言中</el-tag>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="router.push('/me')">我的记录</el-dropdown-item>
                <el-dropdown-item @click="router.push('/me/notifications')">通知中心</el-dropdown-item>
                <el-dropdown-item divided @click="handleLogout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>

        <template v-else>
          <el-button text @click="router.push({ name: 'login' })">登录</el-button>
          <el-button type="primary" @click="router.push({ name: 'register' })">注册</el-button>
        </template>
      </div>
    </header>

    <main class="app-main" :class="{ 'app-main--flush': isMapPage }">
      <RouterView />
    </main>

    <!-- 多端冲突合并确认弹窗：全局唯一，任何页面补传撞上冲突都会弹出 -->
    <MergeConflictDialog v-if="auth.isLoggedIn" />
  </div>
</template>

<style scoped>
.app-user {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 14px;
  color: var(--color-text);
  outline: none;
}

.app-main--flush {
  overflow: hidden;
}

.app-offline-tag {
  margin-right: 4px;
}

.app-offline-tag--action {
  cursor: pointer;
}
</style>
