"""分类推理：LR 主路径 + 原型向量冷启动兜底。"""

from __future__ import annotations

from dataclasses import dataclass

from app.config import settings
from app.services.embedder import embedder
from app.services.model_registry import get_active_bundle, read_active_version
from app.services.prototype import CategoryPrototype, classify_by_prototype


@dataclass(frozen=True)
class ClassifyResult:
    category_id: int | None
    category_code: str | None
    confidence: float
    model_version: str | None
    need_review: bool


def _active_model_version() -> str | None:
    return read_active_version(settings.models_dir)


def _resolve_code(
    category_id: int | None,
    category_code: str | None,
    categories: list[CategoryPrototype],
) -> str | None:
    if category_code:
        return category_code
    if category_id is None:
        return None
    for item in categories:
        if item.id == category_id:
            return item.code
    bundle = get_active_bundle(settings.models_dir)
    if bundle and category_id in bundle.category_ids:
        idx = bundle.category_ids.index(category_id)
        if idx < len(bundle.category_codes):
            return bundle.category_codes[idx]
    return None


def classify_title(title: str, categories: list[CategoryPrototype]) -> ClassifyResult:
    """
    三层策略：
    1. 有已发布 LR → 向量 + LogisticRegression
    2. 置信度 < HIGH → 原型向量余弦相似度
    3. confidence < LOW → need_review=true
    """
    title = title.strip()
    if not title:
        return ClassifyResult(
            category_id=None,
            category_code=None,
            confidence=0.0,
            model_version=None,
            need_review=True,
        )

    usable = [c for c in categories if c.prototype]
    title_vector = embedder.encode([title])[0]
    active_version = _active_model_version()

    category_id: int | None = None
    category_code: str | None = None
    confidence = 0.0
    model_version: str | None = None

    bundle = get_active_bundle(settings.models_dir)
    if bundle is not None:
        lr_id, lr_code, lr_conf = bundle.predict(title_vector)
        if lr_id is not None:
            category_id = lr_id
            category_code = _resolve_code(lr_id, lr_code, categories)
            confidence = lr_conf
            model_version = bundle.version

            if confidence >= settings.high_confidence:
                need_review = confidence < settings.low_confidence
                return ClassifyResult(
                    category_id=category_id,
                    category_code=category_code,
                    confidence=round(confidence, 4),
                    model_version=model_version,
                    need_review=need_review,
                )

    if usable:
        proto_id, proto_code, proto_conf = classify_by_prototype(title_vector, usable)
        if proto_conf > confidence:
            category_id = proto_id
            category_code = proto_code
            confidence = proto_conf
            model_version = None

    if not usable and category_id is None:
        return ClassifyResult(
            category_id=None,
            category_code=None,
            confidence=0.0,
            model_version=None,
            need_review=True,
        )

    need_review = confidence < settings.low_confidence
    return ClassifyResult(
        category_id=category_id,
        category_code=category_code,
        confidence=round(confidence, 4),
        model_version=model_version,
        need_review=need_review,
    )
