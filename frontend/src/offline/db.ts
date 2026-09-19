/**
 * 移动端离线存储（IndexedDB）。
 *
 * 为什么不用 localStorage：
 * - 待补传的照片是 File/Blob，体积可达数 MB，localStorage 装不下也不支持二进制；
 * - 草稿与补传队列要按索引查询，IndexedDB 的 object store 天然支持。
 *
 * 三个 store：
 * - drafts：条目草稿（含尚未创建的本地草稿），key 为本地 clientId；
 * - pending-images：待补传照片，key 为本地 imageId，文件体直接存 Blob；
 * - kv：杂项（设备标识等）。
 */

const DB_NAME = "psdm-offline";
const DB_VERSION = 1;

export const STORE_DRAFTS = "drafts";
export const STORE_PENDING_IMAGES = "pending-images";
export const STORE_OUTBOX = "outbox";
export const STORE_KV = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("当前浏览器不支持 IndexedDB，离线草稿不可用"));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
          const store = db.createObjectStore(STORE_DRAFTS, { keyPath: "clientId" });
          store.createIndex("spotUuid", "spotUuid", { unique: false });
          store.createIndex("updatedAt", "updatedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_PENDING_IMAGES)) {
          const store = db.createObjectStore(STORE_PENDING_IMAGES, { keyPath: "imageId" });
          store.createIndex("clientId", "clientId", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
          db.createObjectStore(STORE_OUTBOX, { keyPath: "clientId" });
        }
        if (!db.objectStoreNames.contains(STORE_KV)) {
          db.createObjectStore(STORE_KV, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function tx<T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = run(transaction.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export async function idbPut<T>(storeName: string, value: T): Promise<void> {
  await tx(storeName, "readwrite", (store) => store.put(value as unknown as object));
}

export async function idbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return tx(storeName, "readonly", (store) => store.get(key) as IDBRequest<T | undefined>);
}

export async function idbGetAll<T>(storeName: string): Promise<T[]> {
  return tx(storeName, "readonly", (store) => store.getAll() as IDBRequest<T[]>);
}

export async function idbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  await tx(storeName, "readwrite", (store) => store.delete(key));
}

export async function idbGetAllByIndex<T>(
  storeName: string,
  indexName: string,
  value: IDBValidKey,
): Promise<T[]> {
  const db = await openDb();
  return new Promise<T[]>((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const index = transaction.objectStore(storeName).index(indexName);
    const request = index.getAll(value);
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

/** 持久化的设备标识：字段时间戳里没有它，但排查多端冲突日志时能对上是哪台设备 */
export async function getDeviceId(): Promise<string> {
  const existing = await idbGet<{ key: string; value: string }>(STORE_KV, "deviceId");
  if (existing?.value) return existing.value;
  const value =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await idbPut(STORE_KV, { key: "deviceId", value });
  return value;
}
