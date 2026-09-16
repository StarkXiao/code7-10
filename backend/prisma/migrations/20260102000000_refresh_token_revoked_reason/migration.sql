-- 刷新令牌的撤销原因
--
-- 重要：这条迁移是手工编写的。
-- prisma migrate diff 生成的版本里含有 DROP INDEX idx_spots_attributes、
-- DROP INDEX idx_spots_title_trgm，以及重建 idx_spots_geo_public（丢掉 WHERE 子句）。
-- 那三个是手工维护的高级索引（GIN / 部分索引），Prisma schema 表达不了，
-- 直接套用自动生成的 SQL 会把它们删掉。
--
-- 因此：不要用 prisma migrate dev 直接生成并套用迁移，
-- 新增迁移前请 review 生成的 SQL，确认没有误删这些手工索引。

ALTER TABLE "refresh_tokens" ADD COLUMN "revoked_reason" TEXT;
