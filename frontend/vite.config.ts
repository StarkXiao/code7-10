import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    // 把体积最大的三个依赖拆出去，避免首页一次加载整包
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-vue": ["vue", "vue-router", "pinia"],
          "vendor-element": ["element-plus", "@element-plus/icons-vue"],
          "vendor-map": ["leaflet", "leaflet.markercluster"],
        },
      },
    },
  },
});
