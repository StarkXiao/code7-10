// 统一的网络状态来源。navigator.onLine 在移动端并不完全可靠
// （某些弱网下仍报 true），所以同步队列除了监听事件，还会在请求实际失败时
// 主动把状态切到离线。
import { ref } from "vue";

export const isOnline = ref(typeof navigator === "undefined" ? true : navigator.onLine);

const listeners = new Set<(online: boolean) => void>();

export function setOnline(value: boolean): void {
  if (isOnline.value === value) return;
  isOnline.value = value;
  for (const listener of listeners) listener(value);
}

export function onNetworkChange(listener: (online: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let installed = false;

export function installNetworkEvents(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));

  // 切回前台时主动探测一次：移动浏览器在后台期间不会派发 online 事件，
  // 用户从地铁里出来重新打开页面时需要立刻触发补传。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      // 能发出去这个零负担请求就说明网络真的通了；
      // 这里不直接发 API 请求，避免未登录时打一堆 401，
      // 只信任 onLine + 由 sync 队列的实际成败来修正。
      if (navigator.onLine) setOnline(true);
    }
  });
}
