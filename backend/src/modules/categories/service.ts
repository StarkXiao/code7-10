import { prisma } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { assertValidSchema, isAttributeSchema, type AttributeSchema } from "./schemaValidator";

export interface CategoryWithSchema {
  id: bigint;
  code: string;
  name: string;
  icon: string;
  color: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  schema: AttributeSchema;
  schemaVersion: number;
}

export async function listCategories(options: { includeInactive?: boolean } = {}): Promise<CategoryWithSchema[]> {
  const categories = await prisma.category.findMany({
    where: options.includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    include: {
      schemas: {
        where: { isCurrent: true },
        take: 1,
      },
    },
  });

  return categories.map((category) => {
    const schema = category.schemas[0];
    if (!schema || !isAttributeSchema(schema.schema)) {
      throw new AppError(
        500,
        "INTERNAL_ERROR",
        `分类 ${category.code} 缺少可用的属性 Schema`,
      );
    }
    return {
      id: category.id,
      code: category.code,
      name: category.name,
      icon: category.icon,
      color: category.color,
      description: category.description,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      schema: schema.schema,
      schemaVersion: schema.version,
    };
  });
}

export async function getCategoryByCode(code: string): Promise<CategoryWithSchema | undefined> {
  const categories = await listCategories({ includeInactive: true });
  return categories.find((category) => category.code === code);
}

export async function requireCategoryByCode(code: string): Promise<CategoryWithSchema> {
  const category = await getCategoryByCode(code);
  if (!category) throw AppError.badRequest(`分类不存在：${code}`);
  if (!category.isActive) throw AppError.badRequest(`分类已停用：${category.name}`);
  return category;
}

export async function createCategory(input: {
  code: string;
  name: string;
  icon: string;
  color: string;
  description?: string;
  sortOrder?: number;
  schema: unknown;
  actorId: bigint;
}) {
  const schema = assertValidSchema(input.schema);

  const existing = await prisma.category.findUnique({ where: { code: input.code } });
  if (existing) throw AppError.conflict("VALIDATION_FAILED", `分类代码已存在：${input.code}`);

  return prisma.category.create({
    data: {
      code: input.code,
      name: input.name,
      icon: input.icon,
      color: input.color,
      description: input.description ?? null,
      sortOrder: input.sortOrder ?? 0,
      schemas: {
        create: {
          version: 1,
          schema: schema as unknown as object,
          isCurrent: true,
          createdBy: input.actorId,
        },
      },
    },
    select: { id: true, code: true, name: true },
  });
}

export async function updateCategory(
  id: bigint,
  input: {
    name?: string;
    icon?: string;
    color?: string;
    description?: string;
    sortOrder?: number;
    isActive?: boolean;
  },
) {
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) throw AppError.notFound("分类不存在");

  return prisma.category.update({
    where: { id },
    data: {
      name: input.name,
      icon: input.icon,
      color: input.color,
      description: input.description,
      sortOrder: input.sortOrder,
      isActive: input.isActive,
    },
    select: { id: true, code: true, name: true, isActive: true },
  });
}

/**
 * 发布新的属性 Schema 版本。
 * 旧版本保留，已有条目不会被破坏；新版本只对新提交生效。
 */
export async function publishSchema(categoryId: bigint, schemaInput: unknown, actorId: bigint) {
  const schema = assertValidSchema(schemaInput);
  const category = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!category) throw AppError.notFound("分类不存在");

  const latest = await prisma.categorySchema.findFirst({
    where: { categoryId },
    orderBy: { version: "desc" },
    select: { version: true, schema: true },
  });

  if (latest && JSON.stringify(latest.schema) === JSON.stringify(schema)) {
    // 内容完全一致时不再产生新版本，避免版本号无意义膨胀
    return { version: latest.version, changed: false };
  }

  const nextVersion = (latest?.version ?? 0) + 1;

  await prisma.$transaction([
    prisma.categorySchema.updateMany({
      where: { categoryId, isCurrent: true },
      data: { isCurrent: false },
    }),
    prisma.categorySchema.create({
      data: {
        categoryId,
        version: nextVersion,
        schema: schema as unknown as object,
        isCurrent: true,
        createdBy: actorId,
      },
    }),
  ]);

  return { version: nextVersion, changed: true, previous: latest?.schema ?? null };
}
