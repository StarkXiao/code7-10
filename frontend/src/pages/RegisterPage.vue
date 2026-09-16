<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const router = useRouter();

const mode = ref<"email" | "phone">("email");
const email = ref("");
const phone = ref("");
const nickname = ref("");
const password = ref("");
const confirm = ref("");

async function submit() {
  if (!nickname.value.trim()) {
    ElMessage.warning("请填写昵称");
    return;
  }
  if (mode.value === "email" && !email.value.trim()) {
    ElMessage.warning("请填写邮箱");
    return;
  }
  if (mode.value === "phone" && !phone.value.trim()) {
    ElMessage.warning("请填写手机号");
    return;
  }
  if (password.value !== confirm.value) {
    ElMessage.warning("两次输入的密码不一致");
    return;
  }

  try {
    await auth.register({
      nickname: nickname.value.trim(),
      password: password.value,
      ...(mode.value === "email" ? { email: email.value.trim() } : { phone: phone.value.trim() }),
    });

    // 注册成功后直接登录，少一步操作
    const account = mode.value === "email" ? email.value.trim() : phone.value.trim();
    await auth.login(account, password.value);
    ElMessage.success("注册成功，欢迎加入");
    void router.replace("/me");
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}
</script>

<template>
  <div class="page auth-page">
    <el-card shadow="never" class="auth-card">
      <h1 style="margin: 0 0 6px; font-size: 20px">注册</h1>
      <p class="muted" style="margin: 0 0 18px">
        我们只要求邮箱或手机号二选一，不会收集你的真实姓名和住址。
      </p>

      <el-radio-group v-model="mode" style="margin-bottom: 16px">
        <el-radio-button value="email">用邮箱</el-radio-button>
        <el-radio-button value="phone">用手机号</el-radio-button>
      </el-radio-group>

      <el-form label-position="top" @submit.prevent>
        <el-form-item v-if="mode === 'email'" label="邮箱">
          <el-input v-model="email" autocomplete="email" placeholder="you@example.com" />
        </el-form-item>
        <el-form-item v-else label="手机号">
          <el-input v-model="phone" autocomplete="tel" maxlength="11" placeholder="13800000000" />
        </el-form-item>

        <el-form-item label="昵称">
          <el-input v-model="nickname" maxlength="20" placeholder="别人会看到的名字，不必使用真名" />
        </el-form-item>

        <el-form-item label="密码">
          <el-input v-model="password" type="password" show-password autocomplete="new-password" />
          <p class="muted" style="margin: 4px 0 0">至少 8 位，需包含字母和数字</p>
        </el-form-item>

        <el-form-item label="再输一次密码">
          <el-input v-model="confirm" type="password" show-password autocomplete="new-password" />
        </el-form-item>

        <el-button type="primary" style="width: 100%" :loading="auth.loading" @click="submit">注册并登录</el-button>
      </el-form>

      <p class="muted" style="margin: 16px 0 0; text-align: center">
        已有账号？<RouterLink to="/login">直接登录</RouterLink>
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
