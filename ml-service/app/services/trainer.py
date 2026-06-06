"""训练流水线：向量提取 → LogisticRegression → 保存模型。"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score
from sklearn.model_selection import train_test_split

from app.config import settings
from app.services.embedder import embedder

_lock = threading.Lock()
_jobs: dict[str, dict[str, Any]] = {}


@dataclass(frozen=True)
class TrainAnnotation:
    title: str
    category_id: int
    category_code: str | None = None


def _set_job(job_id: str, **kwargs: Any) -> None:
    with _lock:
        state = _jobs.setdefault(job_id, {})
        state.update(kwargs)


def get_train_progress(job_id: str) -> dict[str, Any] | None:
    with _lock:
        state = _jobs.get(job_id)
        return dict(state) if state else None


def _next_version(models_dir: Path) -> str:
    models_dir.mkdir(parents=True, exist_ok=True)
    versions: list[int] = []
    for path in models_dir.iterdir():
        if path.is_dir() and path.name.startswith("v"):
            suffix = path.name[1:]
            if suffix.isdigit():
                versions.append(int(suffix))
    return f"v{max(versions) + 1 if versions else 1}"


def _run_training(job_id: str, annotations: list[TrainAnnotation]) -> None:
    try:
        _set_job(
            job_id,
            status="running",
            progress=0,
            stage="prepare",
            error=None,
        )

        dedup: dict[tuple[str, int], TrainAnnotation] = {}
        for item in annotations:
            title = item.title.strip()
            if not title:
                continue
            dedup[(title, item.category_id)] = item
        samples = list(dedup.values())
        if len(samples) < 2:
            raise ValueError("有效训练样本不足（至少 2 条）")

        category_ids = sorted({item.category_id for item in samples})
        if len(category_ids) < 2:
            raise ValueError("训练至少需要 2 个不同类别")

        id_to_code: dict[int, str] = {}
        for item in samples:
            if item.category_code:
                id_to_code[item.category_id] = item.category_code

        _set_job(job_id, stage="embedding", progress=10)
        titles = [item.title for item in samples]
        vectors = embedder.encode(titles)
        labels = np.array([item.category_id for item in samples], dtype=np.int64)

        _set_job(job_id, stage="embedding", progress=60)

        test_size = 0.2 if len(samples) >= 10 else 0.0
        if test_size > 0:
            x_train, x_val, y_train, y_val = train_test_split(
                vectors,
                labels,
                test_size=test_size,
                random_state=42,
                stratify=labels,
            )
        else:
            x_train, y_train = vectors, labels
            x_val, y_val = vectors[:0], labels[:0]

        _set_job(job_id, stage="training", progress=65)
        lr = LogisticRegression(
            max_iter=1000,
            class_weight="balanced",
            random_state=42,
        )
        lr.fit(x_train, y_train)

        _set_job(job_id, stage="evaluating", progress=85)
        metrics: dict[str, Any] = {
            "train_count": int(len(x_train)),
            "val_count": int(len(x_val)),
            "category_count": len(category_ids),
        }

        if len(x_val) > 0:
            y_pred = lr.predict(x_val)
            metrics["accuracy"] = round(float(accuracy_score(y_val, y_pred)), 4)
            metrics["macro_f1"] = round(
                float(f1_score(y_val, y_pred, average="macro", zero_division=0)),
                4,
            )
        else:
            y_pred_train = lr.predict(x_train)
            metrics["accuracy"] = round(float(accuracy_score(y_train, y_pred_train)), 4)
            metrics["macro_f1"] = round(
                float(f1_score(y_train, y_pred_train, average="macro", zero_division=0)),
                4,
            )

        version = _next_version(settings.models_dir)
        model_dir = settings.models_dir / version
        model_dir.mkdir(parents=True, exist_ok=True)

        category_codes = [id_to_code.get(cid, str(cid)) for cid in category_ids]
        payload = {
            "model": lr,
            "category_ids": category_ids,
            "category_codes": category_codes,
        }
        joblib.dump(payload, model_dir / "classifier.pkl")
        (model_dir / "metrics.json").write_text(
            json.dumps(metrics, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        _set_job(
            job_id,
            status="completed",
            progress=100,
            stage="done",
            version=version,
            path=str(model_dir),
            metrics=metrics,
        )
    except Exception as exc:
        _set_job(
            job_id,
            status="failed",
            progress=100,
            stage="failed",
            error=str(exc),
        )


def start_training(job_id: str, annotations: list[TrainAnnotation]) -> None:
    with _lock:
        existing = _jobs.get(job_id)
        if existing and existing.get("status") in {"queued", "running"}:
            raise ValueError(f"训练任务 {job_id} 已在运行")

    _set_job(
        job_id,
        status="queued",
        progress=0,
        stage="queued",
        error=None,
        version=None,
        path=None,
        metrics=None,
    )

    thread = threading.Thread(
        target=_run_training,
        args=(job_id, annotations),
        daemon=True,
        name=f"train-{job_id}",
    )
    thread.start()
