"""已发布 LR 分类器加载与热重载。"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import joblib
import numpy as np

_lock = threading.Lock()
_active_bundle: "ModelBundle | None" = None


@dataclass
class ModelBundle:
    version: str
    path: Path
    model: Any
    category_ids: list[int]
    category_codes: list[str]

    def predict(self, vector: np.ndarray) -> tuple[int | None, str | None, float]:
        if not self.category_ids:
            return None, None, 0.0

        proba = self.model.predict_proba(vector.reshape(1, -1))[0]
        best_idx = int(np.argmax(proba))
        confidence = float(proba[best_idx])
        category_id = self.category_ids[best_idx]
        category_code = (
            self.category_codes[best_idx]
            if best_idx < len(self.category_codes)
            else None
        )
        return category_id, category_code, confidence


def read_active_version(models_dir: Path) -> str | None:
    active_file = models_dir / "active.txt"
    if not active_file.is_file():
        return None
    version = active_file.read_text(encoding="utf-8").strip()
    if not version:
        return None
    classifier_path = models_dir / version / "classifier.pkl"
    return version if classifier_path.is_file() else None


def _load_bundle(version: str, model_dir: Path) -> ModelBundle:
    classifier_path = model_dir / "classifier.pkl"
    if not classifier_path.is_file():
        raise FileNotFoundError(f"未找到分类器文件: {classifier_path}")

    payload = joblib.load(classifier_path)
    if isinstance(payload, dict):
        model = payload["model"]
        category_ids = list(payload.get("category_ids") or [])
        category_codes = list(payload.get("category_codes") or [])
    else:
        raise ValueError("classifier.pkl 格式无效")

    return ModelBundle(
        version=version,
        path=model_dir,
        model=model,
        category_ids=category_ids,
        category_codes=category_codes,
    )


def get_active_bundle(models_dir: Path) -> ModelBundle | None:
    global _active_bundle
    with _lock:
        if _active_bundle is not None:
            return _active_bundle

        version = read_active_version(models_dir)
        if not version:
            return None

        model_dir = models_dir / version
        _active_bundle = _load_bundle(version, model_dir)
        return _active_bundle


def reload_model(version: str, model_path: str | Path, models_dir: Path) -> ModelBundle:
    global _active_bundle
    model_dir = Path(model_path)
    bundle = _load_bundle(version, model_dir)

    models_dir.mkdir(parents=True, exist_ok=True)
    (models_dir / "active.txt").write_text(version, encoding="utf-8")

    metrics_file = model_dir / "metrics.json"
    if metrics_file.is_file():
        # 保留文件即可，无需额外处理
        json.loads(metrics_file.read_text(encoding="utf-8"))

    with _lock:
        _active_bundle = bundle
    return bundle


def clear_active_bundle() -> None:
    global _active_bundle
    with _lock:
        _active_bundle = None
