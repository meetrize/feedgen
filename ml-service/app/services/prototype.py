"""类别原型向量：余弦相似度与批量重建。"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.services.embedder import embedder


@dataclass(frozen=True)
class CategoryPrototype:
    id: int
    code: str
    prototype: list[float]


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """计算两向量的余弦相似度，范围约 [-1, 1]。"""
    a = np.asarray(a, dtype=np.float32).reshape(-1)
    b = np.asarray(b, dtype=np.float32).reshape(-1)
    if a.size == 0 or b.size == 0 or a.shape != b.shape:
        return 0.0

    norm_a = float(np.linalg.norm(a))
    norm_b = float(np.linalg.norm(b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0

    return float(np.dot(a, b) / (norm_a * norm_b))


def rebuild_prototype(examples: list[str]) -> tuple[list[float], int]:
    """根据示例标题均值计算原型向量。"""
    if not examples:
        raise ValueError("examples 不能为空")

    vectors = embedder.encode(examples)
    prototype = vectors.mean(axis=0).astype(np.float32)
    return prototype.tolist(), len(examples)


def classify_by_prototype(
    title_vector: np.ndarray,
    categories: list[CategoryPrototype],
) -> tuple[int | None, str | None, float]:
    """与各类别原型比余弦相似度，返回最佳匹配 (id, code, confidence)。"""
    best_id: int | None = None
    best_code: str | None = None
    best_conf = -1.0

    for category in categories:
        if not category.prototype:
            continue
        proto = np.asarray(category.prototype, dtype=np.float32)
        sim = cosine_similarity(title_vector, proto)
        if sim > best_conf:
            best_conf = sim
            best_id = category.id
            best_code = category.code

    if best_conf < 0.0:
        return None, None, 0.0

    return best_id, best_code, best_conf
