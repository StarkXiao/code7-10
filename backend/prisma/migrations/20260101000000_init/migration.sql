-- ============================================================
-- 公共空间细节地图 - 初始迁移
-- 由 Prisma schema 生成，并在首尾补充扩展与高级索引
-- ============================================================

-- 扩展：pgcrypto 提供 gen_random_uuid()，pg_trgm 提供标题模糊搜索
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('visitor', 'user', 'moderator', 'admin');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'muted', 'banned', 'deleted');

-- CreateEnum
CREATE TYPE "SpotStatus" AS ENUM ('draft', 'pending', 'in_review', 'auto_rejected', 'changes_requested', 'approved', 'published', 'rejected', 'appealing', 'rejected_final', 'hidden', 'archived');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('pending', 'in_review', 'approved', 'changes_requested', 'rejected', 'auto_rejected', 'appealed', 'appeal_approved', 'appeal_rejected');

-- CreateEnum
CREATE TYPE "PrivacyStatus" AS ENUM ('processing', 'auto_clean', 'auto_blurred', 'needs_manual', 'manual_blurred', 'confirmed', 'failed');

-- CreateEnum
CREATE TYPE "CommentStatus" AS ENUM ('pending', 'visible', 'hidden', 'deleted');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('open', 'in_review', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "BlurSource" AS ENUM ('auto', 'manual');

-- CreateEnum
CREATE TYPE "BlurAlgorithm" AS ENUM ('pixelate', 'gaussian');

-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "uuid" UUID NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    "nickname" VARCHAR(32) NOT NULL,
    "avatar_url" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'user',
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "credit_score" SMALLINT NOT NULL DEFAULT 100,
    "approved_count" INTEGER NOT NULL DEFAULT 0,
    "muted_until" TIMESTAMPTZ(6),
    "ban_reason" TEXT,
    "email_notify" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" INET,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" BIGINT NOT NULL,
    "default_fuzz_radius" SMALLINT NOT NULL DEFAULT 50,
    "notify_email" BOOLEAN NOT NULL DEFAULT true,
    "notify_inapp" BOOLEAN NOT NULL DEFAULT true,
    "locale" VARCHAR(8) NOT NULL DEFAULT 'zh-CN',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(32) NOT NULL,
    "icon" VARCHAR(64) NOT NULL,
    "color" VARCHAR(16) NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_schemas" (
    "id" BIGSERIAL NOT NULL,
    "category_id" BIGINT NOT NULL,
    "version" INTEGER NOT NULL,
    "schema" JSONB NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "created_by" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_schemas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spots" (
    "id" BIGSERIAL NOT NULL,
    "uuid" UUID NOT NULL,
    "owner_id" BIGINT NOT NULL,
    "category_id" BIGINT NOT NULL,
    "status" "SpotStatus" NOT NULL DEFAULT 'draft',
    "title" VARCHAR(40) NOT NULL,
    "description" VARCHAR(500),
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "exact_lat" DOUBLE PRECISION NOT NULL,
    "exact_lng" DOUBLE PRECISION NOT NULL,
    "public_lat" DOUBLE PRECISION,
    "public_lng" DOUBLE PRECISION,
    "fuzz_radius_m" SMALLINT NOT NULL DEFAULT 50,
    "fuzz_enabled" BOOLEAN NOT NULL DEFAULT true,
    "address_text" TEXT,
    "freshness_score" SMALLINT NOT NULL DEFAULT 0,
    "is_stale" BOOLEAN NOT NULL DEFAULT false,
    "confirm_count" INTEGER NOT NULL DEFAULT 0,
    "stale_report_count" INTEGER NOT NULL DEFAULT 0,
    "current_revision_id" BIGINT,
    "published_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spot_revisions" (
    "id" BIGSERIAL NOT NULL,
    "spot_id" BIGINT NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "editor_id" BIGINT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spot_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" BIGSERIAL NOT NULL,
    "uuid" UUID NOT NULL,
    "owner_id" BIGINT NOT NULL,
    "spot_id" BIGINT,
    "content_hash" CHAR(64) NOT NULL,
    "original_path" TEXT,
    "original_size" BIGINT NOT NULL,
    "original_mime" VARCHAR(64) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "variants" JSONB NOT NULL DEFAULT '{}',
    "variant_version" INTEGER NOT NULL DEFAULT 1,
    "exif_stripped" BOOLEAN NOT NULL DEFAULT false,
    "privacy_status" "PrivacyStatus" NOT NULL DEFAULT 'processing',
    "privacy_confirmed_by" BIGINT,
    "privacy_confirmed_at" TIMESTAMPTZ(6),
    "detection_meta" JSONB,
    "retry_count" SMALLINT NOT NULL DEFAULT 0,
    "purge_after" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blur_regions" (
    "id" BIGSERIAL NOT NULL,
    "asset_id" BIGINT NOT NULL,
    "source" "BlurSource" NOT NULL,
    "algorithm" "BlurAlgorithm" NOT NULL DEFAULT 'pixelate',
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "w" DOUBLE PRECISION NOT NULL,
    "h" DOUBLE PRECISION NOT NULL,
    "strength" SMALLINT NOT NULL DEFAULT 12,
    "label" VARCHAR(32),
    "confidence" DOUBLE PRECISION,
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "ignore_reason" TEXT,
    "created_by" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blur_regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_tasks" (
    "id" BIGSERIAL NOT NULL,
    "spot_id" BIGINT NOT NULL,
    "revision_id" BIGINT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "priority" SMALLINT NOT NULL DEFAULT 0,
    "auto_check" JSONB,
    "assigned_to" BIGINT,
    "locked_until" TIMESTAMPTZ(6),
    "decided_by" BIGINT,
    "decision_reason" TEXT,
    "reason_code" VARCHAR(48),
    "appeal_of_task_id" BIGINT,
    "appeal_text" TEXT,
    "appeal_deadline" TIMESTAMPTZ(6),
    "sla_due_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" BIGSERIAL NOT NULL,
    "spot_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "parent_id" BIGINT,
    "body" VARCHAR(300) NOT NULL,
    "status" "CommentStatus" NOT NULL DEFAULT 'pending',
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "edit_count" SMALLINT NOT NULL DEFAULT 0,
    "hidden_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_revisions" (
    "id" BIGSERIAL NOT NULL,
    "comment_id" BIGINT NOT NULL,
    "body" VARCHAR(300) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spot_confirmations" (
    "id" BIGSERIAL NOT NULL,
    "spot_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "is_accurate" BOOLEAN NOT NULL,
    "note" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spot_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favorites" (
    "user_id" BIGINT NOT NULL,
    "spot_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("user_id","spot_id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" BIGSERIAL NOT NULL,
    "reporter_id" BIGINT NOT NULL,
    "target_type" VARCHAR(16) NOT NULL,
    "target_id" BIGINT NOT NULL,
    "reason" VARCHAR(32) NOT NULL,
    "detail" VARCHAR(200),
    "status" "ReportStatus" NOT NULL DEFAULT 'open',
    "merged_into" BIGINT,
    "handled_by" BIGINT,
    "handle_result" TEXT,
    "handled_at" TIMESTAMPTZ(6),
    "sla_due_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "title" VARCHAR(80) NOT NULL,
    "body" VARCHAR(300),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ(6),
    "email_sent" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" BIGINT,
    "action" VARCHAR(48) NOT NULL,
    "target_type" VARCHAR(24),
    "target_id" BIGINT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" INET,
    "user_agent" TEXT,
    "trace_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_uuid_key" ON "users"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "idx_users_role_status" ON "users"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "idx_refresh_user" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_code_key" ON "categories"("code");

-- CreateIndex
CREATE INDEX "idx_category_schema_current" ON "category_schemas"("category_id", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "category_schemas_category_id_version_key" ON "category_schemas"("category_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "spots_uuid_key" ON "spots"("uuid");

-- CreateIndex
CREATE INDEX "idx_spots_geo_public" ON "spots"("public_lat", "public_lng");

-- CreateIndex
CREATE INDEX "idx_spots_category" ON "spots"("category_id", "status");

-- CreateIndex
CREATE INDEX "idx_spots_owner" ON "spots"("owner_id", "status");

-- CreateIndex
CREATE INDEX "idx_spots_stale" ON "spots"("status", "is_stale");

-- CreateIndex
CREATE UNIQUE INDEX "spot_revisions_spot_id_revision_no_key" ON "spot_revisions"("spot_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_uuid_key" ON "media_assets"("uuid");

-- CreateIndex
CREATE INDEX "idx_media_spot" ON "media_assets"("spot_id");

-- CreateIndex
CREATE INDEX "idx_media_privacy" ON "media_assets"("privacy_status");

-- CreateIndex
CREATE INDEX "idx_media_hash" ON "media_assets"("content_hash");

-- CreateIndex
CREATE INDEX "idx_media_purge" ON "media_assets"("purge_after");

-- CreateIndex
CREATE INDEX "idx_blur_asset" ON "blur_regions"("asset_id", "ignored");

-- CreateIndex
CREATE INDEX "idx_review_queue" ON "review_tasks"("status", "priority", "created_at");

-- CreateIndex
CREATE INDEX "idx_review_assignee" ON "review_tasks"("assigned_to", "status");

-- CreateIndex
CREATE INDEX "idx_review_sla" ON "review_tasks"("sla_due_at");

-- CreateIndex
CREATE INDEX "idx_comments_spot" ON "comments"("spot_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "idx_comments_user" ON "comments"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_confirm_spot_user" ON "spot_confirmations"("spot_id", "user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_report_queue" ON "reports"("status", "sla_due_at");

-- CreateIndex
CREATE INDEX "idx_report_target" ON "reports"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_reporter_id_target_type_target_id_key" ON "reports"("reporter_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "idx_notify_user" ON "notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "idx_audit_actor" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_audit_target" ON "audit_logs"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_audit_action" ON "audit_logs"("action", "created_at");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_schemas" ADD CONSTRAINT "category_schemas_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_schemas" ADD CONSTRAINT "category_schemas_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spots" ADD CONSTRAINT "spots_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spots" ADD CONSTRAINT "spots_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spot_revisions" ADD CONSTRAINT "spot_revisions_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "spots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spot_revisions" ADD CONSTRAINT "spot_revisions_editor_id_fkey" FOREIGN KEY ("editor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "spots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_privacy_confirmed_by_fkey" FOREIGN KEY ("privacy_confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blur_regions" ADD CONSTRAINT "blur_regions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blur_regions" ADD CONSTRAINT "blur_regions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "spots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "spot_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_appeal_of_task_id_fkey" FOREIGN KEY ("appeal_of_task_id") REFERENCES "review_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "spots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_revisions" ADD CONSTRAINT "comment_revisions_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spot_confirmations" ADD CONSTRAINT "spot_confirmations_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "spots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spot_confirmations" ADD CONSTRAINT "spot_confirmations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "spots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_handled_by_fkey" FOREIGN KEY ("handled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_merged_into_fkey" FOREIGN KEY ("merged_into") REFERENCES "reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 以下为 Prisma schema 无法表达的高级索引，手工补充
-- ============================================================

-- 标题三元组模糊搜索
CREATE INDEX IF NOT EXISTS idx_spots_title_trgm ON "spots" USING GIN ("title" gin_trgm_ops);

-- 属性 JSONB 检索（属性筛选 attr=has_backrest:true）
CREATE INDEX IF NOT EXISTS idx_spots_attributes ON "spots" USING GIN ("attributes");

-- 公开坐标索引仅覆盖已发布条目，减小索引体积
DROP INDEX IF EXISTS "idx_spots_geo_public";
CREATE INDEX IF NOT EXISTS idx_spots_geo_public
  ON "spots" ("public_lat", "public_lng") WHERE "status" = 'published';

-- 审核领取锁：仅对进行中的任务建索引
CREATE INDEX IF NOT EXISTS idx_review_locked
  ON "review_tasks" ("locked_until") WHERE "locked_until" IS NOT NULL;

-- 待清理的原图
CREATE INDEX IF NOT EXISTS idx_media_purge_pending
  ON "media_assets" ("purge_after") WHERE "original_path" IS NOT NULL;
