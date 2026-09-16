import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import L from "leaflet";

import "element-plus/dist/index.css";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import "@/styles/main.css";

import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

import App from "@/App.vue";
import router from "@/router";

// Leaflet 默认图标走的是打包器处理过的资源路径，
// 不显式设置的话生产构建后标记会变成裂图。
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

const app = createApp(App);

for (const [name, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, component);
}

app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });
app.mount("#app");
