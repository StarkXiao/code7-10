-- 移动端离线草稿与断网补传
--
-- 1. spot_field_timestamps：逐字段最后修改时间，多端冲突按时间戳合并；
-- 2. idempotency_keys：断网重试同一写请求时返回首次结果，避免产生重复草稿。
--
-- 本迁移为手工编写：不触碰 idx_spots_title_trgm / idx_spots_attributes /
-- idx_spots_geo_public 三个手工维护的高级索引。

CREATE TABLE "spot_field_timestamps" (
    "id" BIGSERIAL PRIMARY KEY,
    "spot_id" BIGINT NOT NULL,
    "field" VARCHAR(64) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL
);

ALTER TABLE "spot_field_timestamps"
    ADD CONSTRAINT "spot_field_ts_spot_field_key" UNIQUE ("spot_id", "field");

CREATE INDEX "idx_spot_field_ts_spot" ON "spot_field_timestamps"("spot_id");

ALTER TABLE "spot_field_timestamps"
    ADD CONSTRAINT "spot_field_timestamps_spot_id_fkey"
    FOREIGN KEY ("spot_id") REFERENCES "spots"("id") ON DELETE CASCADE;

CREATE TABLE "idempotency_keys" (
    "id" BIGSERIAL PRIMARY KEY,
    "user_id" BIGINT NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "method" VARCHAR(10) NOT NULL,
    "path" VARCHAR(255) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "expires_at" TIMESTAMPTZ(6) NOT NULL
);

ALTER TABLE "idempotency_keys"
    ADD CONSTRAINT "idempotency_user_key" UNIQUE ("user_id", "key");

CREATE INDEX "idx_idempotency_expires" ON "idempotency_keys"("expires_at");

ALTER TABLE "idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
