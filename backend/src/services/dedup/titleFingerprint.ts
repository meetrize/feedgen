import { computeSimhash } from './simhash';
import { normalizeTitle } from './titleNormalize';

/** 入库时轻量写入的查重字段（不做簇合并） */
export function buildTitleDedupFields(title: string | null | undefined): {
  title_norm: string | null;
  title_simhash: bigint | null;
} {
  const title_norm = normalizeTitle(title);
  if (!title_norm) {
    return { title_norm: null, title_simhash: null };
  }
  return {
    title_norm,
    title_simhash: computeSimhash(title_norm),
  };
}
