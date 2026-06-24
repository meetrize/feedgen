"""gte-small-zh 向量提取（单例，CPU，懒加载）。"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING

import numpy as np

from app.config import settings

if TYPE_CHECKING:
    import torch
    from transformers import AutoModel, AutoTokenizer


class GteEmbedder:
    """thenlper/gte-small-zh 封装，支持批量 mean pooling。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tokenizer: AutoTokenizer | None = None
        self._model: AutoModel | None = None
        self._device: str = "cpu"
        self._ready = False

    @property
    def ready(self) -> bool:
        return self._ready

    def _ensure_loaded(self) -> None:
        if self._ready:
            return
        with self._lock:
            if self._ready:
                return
            import torch
            from transformers import AutoModel, AutoTokenizer

            tokenizer = AutoTokenizer.from_pretrained(settings.embed_model)
            model = AutoModel.from_pretrained(settings.embed_model)
            model.to(self._device)
            model.eval()

            self._tokenizer = tokenizer
            self._model = model
            self._ready = True

    def encode(self, texts: list[str]) -> np.ndarray:
        """将文本列表编码为 (N, dim) float32 向量。"""
        if not texts:
            return np.zeros((0, 0), dtype=np.float32)

        self._ensure_loaded()
        assert self._tokenizer is not None
        assert self._model is not None

        import torch

        batch_size = max(1, settings.embed_batch_size)
        chunks: list[np.ndarray] = []

        for start in range(0, len(texts), batch_size):
            batch = texts[start : start + batch_size]
            encoded = self._tokenizer(
                batch,
                padding=True,
                truncation=True,
                max_length=512,
                return_tensors="pt",
            )
            encoded = {key: value.to(self._device) for key, value in encoded.items()}

            with torch.no_grad():
                outputs = self._model(**encoded)
                embeddings = _mean_pooling(outputs.last_hidden_state, encoded["attention_mask"])

            chunks.append(embeddings.cpu().numpy().astype(np.float32))

        return np.vstack(chunks)


def _mean_pooling(
    token_embeddings: "torch.Tensor",
    attention_mask: "torch.Tensor",
) -> "torch.Tensor":
    import torch

    mask = attention_mask.unsqueeze(-1).expand(token_embeddings.size()).float()
    summed = torch.sum(token_embeddings * mask, dim=1)
    counts = torch.clamp(mask.sum(dim=1), min=1e-9)
    return summed / counts


embedder = GteEmbedder()
