<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { api } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { useNotificationStore } from "@/stores/notifications";

const auth = useAuthStore();
const notifications = useNotificationStore();
const route = useRoute();
const router = useRouter();

const account = ref("");
const password = ref("");
const captchaCode = ref("");
const captchaSvg = ref<string | null>(null);
const captchaId = ref<string | null>(null);
const showCaptcha = ref(false);

const redirect = computed(() => (typeof route.query.redirect === "string" ? route.query.redirect : "/"));

async function loadCaptcha() {
  const result = await api.get<{ required: boolean; captchaId: string | null; svg: string | null }>(
    "/auth/captcha",
    undefined,
  );
  if (result.required) {
    showCaptcha.value = true;
    captchaId.value = result.captchaId;
    captchaSvg.value = result.svg;
  }
}

async function submit() {
  if (!account.value.trim() || !password.value) {
    ElMessage.warning("请填写账号和密码");
    return;
  }
  if (showCaptcha.value && !captchaCode.value.trim()) {
    ElMessage.warning("请填写图形验证码");
    return;
  }

  try {
    await auth.login(
      account.value.trim(),
      password.value,
      showCaptcha.value && captchaId.value
        ? { id: captchaId.value, code: captchaCode.value.trim() }
        : undefined,
    );
    await notifications.load().catch(() => undefined);
    ElMessage.success("登录成功");
    void router.replace(redirect.value);
  } catch (error) {
    // 失败累计到阈值后服务端要求验证码；这里按需把验证码显示出来
    const message = (error as Error).message;
    ElMessage.error(message);
    void loadCaptcha();
  }
}
</script>

<template>
  <div class="page auth-page">
    <el-card shadow="never" class="auth-card">
      <h1 style="margin: 0 0 6px; font-size: 20px">登录</h1>
      <p class="muted" style="margin: 0 0 18px">登录后可以记录细节、评论和确认信息</p>

      <el-form label-position="top" @submit.prevent>
        <el-form-item label="邮箱或手机号">
          <el-input v-model="account" autocomplete="username" placeholder="you@example.com" />
        </el-form-item>

        <el-form-item label="密码">
          <el-input
            v-model="password"
            type="password"
            show-password
            autocomplete="current-password"
            @keyup.enter="submit"
          />
        </el-form-item>

        <el-form-item v-if="showCaptcha" label="图形验证码">
          <div style="display: flex; gap: 10px; align-items: center; width: 100%">
            <el-input v-model="captchaCode" style="flex: 1" maxlength="4" />
            <div
              v-if="captchaSvg"
              style="cursor: pointer; line-height: 0"
              title="点击换一张"
              @click="loadCaptcha"
              v-html="captchaSvg"
            />
          </div>
        </el-form-item>

        <el-button type="primary" style="width: 100%" :loading="auth.loading" @click="submit">登录</el-button>
      </el-form>

      <p class="muted" style="margin: 16px 0 0; text-align: center">
        还没有账号？<RouterLink to="/register">立即注册</RouterLink>
      </p>
    </el-card>
  </div>
</template>

<style scoped>
.auth-page {
  display: flex;
  justify-content: center;
}

.auth-card {
  width: 100%;
  max-width: 420px;
  margin-top: 24px;
}
</style>
