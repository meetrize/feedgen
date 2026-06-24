"""FeedGen ML Sidecar — FastAPI 入口。"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.services.classifier import classify_title
from app.services.embedder import embedder
from app.services.model_registry import read_active_version, reload_model
from app.services.prototype import CategoryPrototype, rebuild_prototype
from app.services.trainer import TrainAnnotation, get_train_progress, start_training

app = FastAPI(title="FeedGen ML Service", version="0.3.0")


class HealthResponse(BaseModel):
    status: str
    embedder_ready: bool
    active_model: str | None


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1)


class EmbedResponse(BaseModel):
    vectors: list[list[float]]


class CategoryInput(BaseModel):
    id: int
    code: str
    prototype: list[float] = Field(..., min_length=1)


class ClassifyRequest(BaseModel):
    title: str = Field(..., min_length=1)
    categories: list[CategoryInput] = Field(default_factory=list)


class ClassifyResponse(BaseModel):
    category_id: int | None
    category_code: str | None
    confidence: float
    model_version: str | None
    need_review: bool


class PrototypeRebuildRequest(BaseModel):
    examples: list[str] = Field(..., min_length=1)


class PrototypeRebuildResponse(BaseModel):
    prototype: list[float]
    example_count: int


class TrainAnnotationInput(BaseModel):
    title: str
    category_id: int
    category_code: str | None = None


class TrainRequest(BaseModel):
    job_id: str | int
    annotations: list[TrainAnnotationInput] = Field(..., min_length=2)


class TrainStartResponse(BaseModel):
    job_id: str
    status: str


class TrainProgressResponse(BaseModel):
    job_id: str
    status: str
    progress: int
    stage: str | None = None
    version: str | None = None
    path: str | None = None
    metrics: dict | None = None
    error: str | None = None


class ReloadModelRequest(BaseModel):
    version: str
    path: str


class ReloadModelResponse(BaseModel):
    version: str
    path: str
    active: bool


def verify_internal_token(
    x_internal_token: Annotated[str | None, Header()] = None,
) -> None:
    if not x_internal_token or x_internal_token != settings.token:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Internal-Token")


@app.get("/internal/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        embedder_ready=embedder.ready,
        active_model=read_active_version(settings.models_dir),
    )


@app.post(
    "/internal/embed",
    response_model=EmbedResponse,
    dependencies=[Depends(verify_internal_token)],
)
def embed(body: EmbedRequest) -> EmbedResponse:
    vectors = embedder.encode(body.texts)
    return EmbedResponse(vectors=vectors.tolist())


@app.post(
    "/internal/classify",
    response_model=ClassifyResponse,
    dependencies=[Depends(verify_internal_token)],
)
def classify(body: ClassifyRequest) -> ClassifyResponse:
    categories = [
        CategoryPrototype(id=item.id, code=item.code, prototype=item.prototype)
        for item in body.categories
    ]
    result = classify_title(body.title, categories)
    return ClassifyResponse(
        category_id=result.category_id,
        category_code=result.category_code,
        confidence=result.confidence,
        model_version=result.model_version,
        need_review=result.need_review,
    )


@app.post(
    "/internal/prototype/rebuild",
    response_model=PrototypeRebuildResponse,
    dependencies=[Depends(verify_internal_token)],
)
def prototype_rebuild(body: PrototypeRebuildRequest) -> PrototypeRebuildResponse:
    prototype, example_count = rebuild_prototype(body.examples)
    return PrototypeRebuildResponse(
        prototype=prototype,
        example_count=example_count,
    )


@app.post(
    "/internal/train",
    response_model=TrainStartResponse,
    dependencies=[Depends(verify_internal_token)],
)
def train_start(body: TrainRequest) -> TrainStartResponse:
    job_id = str(body.job_id)
    annotations = [
        TrainAnnotation(
            title=item.title,
            category_id=item.category_id,
            category_code=item.category_code,
        )
        for item in body.annotations
    ]
    try:
        start_training(job_id, annotations)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return TrainStartResponse(job_id=job_id, status="queued")


@app.get(
    "/internal/train/{job_id}/progress",
    response_model=TrainProgressResponse,
    dependencies=[Depends(verify_internal_token)],
)
def train_progress(job_id: str) -> TrainProgressResponse:
    state = get_train_progress(job_id)
    if not state:
        raise HTTPException(status_code=404, detail="训练任务不存在")
    return TrainProgressResponse(
        job_id=job_id,
        status=state.get("status", "unknown"),
        progress=int(state.get("progress") or 0),
        stage=state.get("stage"),
        version=state.get("version"),
        path=state.get("path"),
        metrics=state.get("metrics"),
        error=state.get("error"),
    )


@app.post(
    "/internal/reload-model",
    response_model=ReloadModelResponse,
    dependencies=[Depends(verify_internal_token)],
)
def reload_model_endpoint(body: ReloadModelRequest) -> ReloadModelResponse:
    try:
        bundle = reload_model(body.version, body.path, settings.models_dir)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ReloadModelResponse(version=bundle.version, path=str(bundle.path), active=True)
