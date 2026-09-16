import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../config/constants";

export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export function parsePagination(query: { page?: unknown; pageSize?: unknown }): Pagination {
  const rawPage = Number(query.page ?? 1);
  const rawSize = Number(query.pageSize ?? DEFAULT_PAGE_SIZE);

  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const pageSize = Number.isFinite(rawSize) && rawSize >= 1 ? Math.min(Math.floor(rawSize), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function pagedResult<T>(items: T[], total: number, pagination: Pagination) {
  return {
    items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
  };
}
