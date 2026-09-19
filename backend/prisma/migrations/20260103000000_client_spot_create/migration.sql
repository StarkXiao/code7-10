-- 断网补传幂等表：移动端重试 POST /spots 时靠 (owner_id, client_key) 去重
CREATE TABLE "client_spot_creates" (
    "id" BIGSERIAL NOT NULL,
    "owner_id" BIGINT NOT NULL,
    "client_key" VARCHAR(64) NOT NULL,
    "spot_id" BIGINT NOT NULL,
    "spot_uuid" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_spot_creates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_spot_creates_owner_key" ON "client_spot_creates"("owner_id", "client_key");
CREATE INDEX "idx_client_spot_creates_created" ON "client_spot_creates"("created_at");

ALTER TABLE "client_spot_creates"
  ADD CONSTRAINT "client_spot_creates_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "client_spot_creates"
  ADD CONSTRAINT "client_spot_creates_spot_id_fkey"
  FOREIGN KEY ("spot_id") REFERENCES "spots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
