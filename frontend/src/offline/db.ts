// IndexedDB 极简封装：只存两类东西——
//   1. drafts：离线草稿（结构化数据，含各字段修改时间戳、同步状态）
//   2. media：断网时选好但没传上去的图片 Blob
//
// 为什么不用 localStorage：图片是二进制，塞 base64 进 localStorage 会撑爆
// （常见上限只有 5MB），而且 IndexedDB 的异步读写不会卡住主线程。

const DB_NAME = "psdm-offline";
const DB_VERSION = 1;
const STORE_DRAFTS = "drafts";
const STORE_MEDIA = "media";

let dbPromise: Promise<IDBDatabase> | null = null;

export class LocalDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalDbError";
  }
}

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && typeof indexedDB.open === "function";
}

function openDb(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new LocalDbError("当前环境不支持本地离线存储（IndexedDB 不可用）"));
  }

  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
          const drafts = db.createObjectStore(STORE_DRAFTS, { keyPath: "key" });
          drafts.createIndex("status", "status", { unique: false });
          drafts.createIndex("updatedAt", "updatedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_MEDIA)) {
          db.createObjectStore(STORE_MEDIA, { keyPath: "localId" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new LocalDbError("打开本地数据库失败"));
      request.onblocked = () => reject(new LocalDbError("本地数据库被其他标签页占用"));
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
        request.onerror = () => reject(request.error ?? new LocalDbError("本地数据库读写失败"));
        transaction.onerror = () => reject(transaction.error ?? new LocalDbError("本地数据库事务失败"));
      }),
  );
}

// ------------------------------------------------------------------ drafts

export interface PendingPhoto {
  /** 本机生成的临时 id，也是 media store 里的键 */
  localId: string;
  name: string;
  mimeType: string;
  size: number;
  /** 上传成功后回填的服务端 uuid */
  serverUuid?: string;
}

export type DraftSyncStatus = "local" | "queued" | "syncing" | "conflict" | "error" | "synced";

export interface LocalDraft {
  /** 已存在条目用其 uuid；新建条目用 "new:" 前缀的本机临时键 */
  key: string;
  spotUuid: string | null;
  title: string;
  categoryCode: string;
  description: string;
  attributes: Record<string, unknown>;
  lat: number;
  lng: number;
  fuzzEnabled: boolean;
  fuzzRadiusM: number;
  /** 已上传成功的图片 uuid */
  mediaUuids: string[];
  /** 断网期间选取、尚未上传的图片 */
  pendingPhotos: PendingPhoto[];
  /** 各字段最后修改时间戳（epoch ms），用于多端合并 */
  fieldTimestamps: import("./merge").FieldTimestamps;
  /** 进入编辑页时的字段时间戳基线，补传时判定远端是否被别处改过 */
  baselineTimestamps: import("./merge").FieldTimestamps;
  /** 最近一次从服务端读到的 updatedAt（ISO 字符串），作为乐观锁依据 */
  baseUpdatedAt: string | null;
  status: DraftSyncStatus;
  lastError: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export async function putDraft(draft: LocalDraft): Promise<void> {
  await tx(STORE_DRAFTS, "readwrite", (store) => store.put(draft));
}

export async function getDraft(key: string): Promise<LocalDraft | undefined> {
  return tx(STORE_DRAFTS, "readonly", (store) => store.get(key) as IDBRequest<LocalDraft | undefined>);
}

export async function deleteDraft(key: string): Promise<void> {
  await tx(STORE_DRAFTS, "readwrite", (store) => store.delete(key));
}

export async function listDrafts(): Promise<LocalDraft[]> {
  const drafts = await tx(STORE_DRAFTS, "readonly", (store) =>
    store.getAll() as IDBRequest<LocalDraft[]>,
  );
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ------------------------------------------------------------------ media

export interface LocalMediaRecord {
  localId: string;
  blob: Blob;
  createdAt: number;
}

export async function putMedia(record: LocalMediaRecord): Promise<void> {
  await tx(STORE_MEDIA, "readwrite", (store) => store.put(record));
}

export async function getMedia(localId: string): Promise<LocalMediaRecord | undefined> {
  return tx(STORE_MEDIA, "readonly", (store) =>
    store.get(localId) as IDBRequest<LocalMediaRecord | undefined>,
  );
}

export async function deleteMedia(localId: string): Promise<void> {
  await tx(STORE_MEDIA, "readwrite", (store) => store.delete(localId));
}

/** 删除一张草稿已经不再引用的图片，避免二进制长期占空间 */
export async function pruneOrphanMedia(referencedIds: Set<string>): Promise<void> {
  const db = await openDb();
  const all = await tx(STORE_MEDIA, "readonly", (store) =>
    store.getAllKeys() as IDBRequest<IDBValidKey[]>,
  );
  const transaction = db.transaction(STORE_MEDIA, "readwrite");
  const store = transaction.objectStore(STORE_MEDIA);
  for (const key of all) {
    if (!referencedIds.has(String(key))) store.delete(key);
  }
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export function makeLocalId(): string {
  // 不用 uuid 库：crypto.randomUUID 在所有受支持的移动浏览器上都可用，
  // 兜底用时间戳 + 随机数。
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ph-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
