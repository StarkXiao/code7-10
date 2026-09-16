<template>
  <div class="page">
    <el-result icon="warning" title="页面不存在" sub-title="链接可能已经失效，或者这条内容还没有发布">
      <template #extra>
        <RouterLink to="/">
          <el-button type="primary">回到地图</el-button>
        </RouterLink>
      </template>
    </el-result>
  </div>
</template>
