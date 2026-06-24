import type { NewsCategory, NewsCategoryExample, NewsCategoryPrototype } from '@prisma/client';

import { prisma } from '../../server';
import * as mlClient from './mlClient';

export type CategoryListItem = {
  id: number;
  code: string;
  name: string;
  description: string | null;
  color: string | null;
  status: string;
  sort_order: number;
  example_count: number;
  prototype_ready: boolean;
  created_at: Date;
  updated_at: Date;
};

/** 用户侧只读类别（active） */
export type PublicCategoryItem = {
  id: number;
  code: string;
  name: string;
  color: string | null;
  sort_order: number;
};

export type CreateCategoryInput = {
  code: string;
  name: string;
  description?: string | null;
  color?: string | null;
  sort_order?: number;
  examples?: string[];
};

export type UpdateCategoryInput = {
  code?: string;
  name?: string;
  description?: string | null;
  color?: string | null;
  sort_order?: number;
  status?: string;
  examples?: string[];
};

type CategoryWithRelations = NewsCategory & {
  examples: NewsCategoryExample[];
  prototype: NewsCategoryPrototype | null;
};

function normalizeCode(code: string): string {
  const normalized = code.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('code 仅允许小写字母、数字、下划线与连字符，且以字母开头');
  }
  return normalized;
}

function normalizeExamples(examples?: string[]): string[] {
  if (!examples?.length) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of examples) {
    const title = raw.trim();
    if (!title || seen.has(title)) {
      continue;
    }
    seen.add(title);
    result.push(title);
  }
  return result;
}

function vectorToBytes(vector: number[]): Buffer {
  const arr = new Float32Array(vector);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

async function syncPrototype(categoryId: number, exampleTitles: string[]): Promise<void> {
  if (!exampleTitles.length) {
    await prisma.newsCategoryPrototype.deleteMany({ where: { category_id: categoryId } });
    return;
  }

  const rebuilt = await mlClient.rebuildPrototype(exampleTitles);
  const embedding = vectorToBytes(rebuilt.prototype);

  await prisma.newsCategoryPrototype.upsert({
    where: { category_id: categoryId },
    create: {
      category_id: categoryId,
      embedding,
      example_count: rebuilt.example_count,
      updated_at: new Date(),
    },
    update: {
      embedding,
      example_count: rebuilt.example_count,
      updated_at: new Date(),
    },
  });
}

function toListItem(category: CategoryWithRelations): CategoryListItem {
  return {
    id: category.id,
    code: category.code,
    name: category.name,
    description: category.description,
    color: category.color,
    status: category.status,
    sort_order: category.sort_order,
    example_count: category.examples.length,
    prototype_ready: category.prototype != null,
    created_at: category.created_at,
    updated_at: category.updated_at,
  };
}

async function getCategoryOrThrow(id: number): Promise<CategoryWithRelations> {
  const category = await prisma.newsCategory.findUnique({
    where: { id },
    include: {
      examples: { orderBy: { id: 'asc' } },
      prototype: true,
    },
  });
  if (!category) {
    throw new Error('类别不存在');
  }
  return category;
}

export async function listPublicCategories(): Promise<PublicCategoryItem[]> {
  return prisma.newsCategory.findMany({
    where: { status: 'active' },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      code: true,
      name: true,
      color: true,
      sort_order: true,
    },
  });
}

export async function listCategories(): Promise<CategoryListItem[]> {
  const categories = await prisma.newsCategory.findMany({
    orderBy: [{ status: 'asc' }, { sort_order: 'asc' }, { id: 'asc' }],
    include: {
      examples: true,
      prototype: true,
    },
  });
  return categories.map(toListItem);
}

export async function createCategory(input: CreateCategoryInput): Promise<CategoryListItem> {
  const code = normalizeCode(input.code);
  const name = input.name.trim();
  if (!name) {
    throw new Error('name 不能为空');
  }

  const examples = normalizeExamples(input.examples);

  const category = await prisma.newsCategory.create({
    data: {
      code,
      name,
      description: input.description?.trim() || null,
      color: input.color?.trim() || null,
      sort_order: input.sort_order ?? 0,
      examples: examples.length
        ? {
            create: examples.map((title) => ({ title })),
          }
        : undefined,
    },
    include: {
      examples: true,
      prototype: true,
    },
  });

  if (examples.length) {
    await syncPrototype(category.id, examples);
    return toListItem(await getCategoryOrThrow(category.id));
  }

  return toListItem(category);
}

export async function updateCategory(
  id: number,
  input: UpdateCategoryInput,
): Promise<CategoryListItem> {
  await getCategoryOrThrow(id);

  const data: Record<string, unknown> = { updated_at: new Date() };
  if (input.code !== undefined) {
    data.code = normalizeCode(input.code);
  }
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) {
      throw new Error('name 不能为空');
    }
    data.name = name;
  }
  if (input.description !== undefined) {
    data.description = input.description?.trim() || null;
  }
  if (input.color !== undefined) {
    data.color = input.color?.trim() || null;
  }
  if (input.sort_order !== undefined) {
    data.sort_order = input.sort_order;
  }
  if (input.status !== undefined) {
    data.status = input.status;
  }

  await prisma.newsCategory.update({
    where: { id },
    data,
  });

  if (input.examples !== undefined) {
    const examples = normalizeExamples(input.examples);
    await prisma.newsCategoryExample.deleteMany({ where: { category_id: id } });
    if (examples.length) {
      await prisma.newsCategoryExample.createMany({
        data: examples.map((title) => ({ category_id: id, title })),
      });
    }
    await syncPrototype(id, examples);
  }

  return toListItem(await getCategoryOrThrow(id));
}

export async function disableCategory(id: number): Promise<CategoryListItem> {
  await prisma.newsCategory.update({
    where: { id },
    data: {
      status: 'disabled',
      updated_at: new Date(),
    },
  });
  return toListItem(await getCategoryOrThrow(id));
}

export async function appendExamples(
  id: number,
  titles: string[],
): Promise<CategoryListItem> {
  const category = await getCategoryOrThrow(id);
  const newTitles = normalizeExamples(titles);
  if (!newTitles.length) {
    throw new Error('titles 不能为空');
  }

  const existing = new Set(category.examples.map((item) => item.title));
  const toInsert = newTitles.filter((title) => !existing.has(title));
  if (toInsert.length) {
    await prisma.newsCategoryExample.createMany({
      data: toInsert.map((title) => ({ category_id: id, title })),
    });
  }

  const refreshed = await getCategoryOrThrow(id);
  const allTitles = refreshed.examples.map((item) => item.title);
  await syncPrototype(id, allTitles);
  return toListItem(await getCategoryOrThrow(id));
}
