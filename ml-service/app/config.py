"""ML 服务配置（环境变量）。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    port: int
    token: str
    models_dir: Path
    keyatten_venv: Path
    embed_model: str
    embed_batch_size: int
    high_confidence: float
    low_confidence: float

    @classmethod
    def from_env(cls) -> "Settings":
        token = os.getenv("ML_SERVICE_TOKEN", "").strip()
        if not token:
            raise RuntimeError("ML_SERVICE_TOKEN 未设置")

        return cls(
            port=int(os.getenv("ML_SERVICE_PORT", "3010")),
            token=token,
            models_dir=Path(
                os.getenv("ML_MODELS_DIR", "/www/wwwroot/pro/ml-service/models")
            ),
            keyatten_venv=Path(
                os.getenv("KEYATTEN_VENV", "/www/wwwroot/keyatten/miniconda")
            ),
            embed_model=os.getenv("ML_EMBED_MODEL", "thenlper/gte-small-zh"),
            embed_batch_size=int(os.getenv("ML_EMBED_BATCH_SIZE", "32")),
            high_confidence=float(os.getenv("ML_HIGH_CONFIDENCE", "0.65")),
            low_confidence=float(os.getenv("ML_LOW_CONFIDENCE", "0.50")),
        )


settings = Settings.from_env()
