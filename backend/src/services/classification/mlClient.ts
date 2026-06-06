import axios, { AxiosError } from 'axios';

export type CategoryPrototypeInput = {
  id: number;
  code: string;
  prototype: number[];
};

export type ClassifyResult = {
  category_id: number | null;
  category_code: string | null;
  confidence: number;
  model_version: string | null;
  need_review: boolean;
};

export type RebuildPrototypeResult = {
  prototype: number[];
  example_count: number;
};

export type MlHealthResult = {
  status: string;
  embedder_ready: boolean;
  active_model: string | null;
};

function getBaseUrl(): string {
  return (process.env.ML_SERVICE_URL || 'http://127.0.0.1:3010').replace(/\/$/, '');
}

function getToken(): string {
  const token = process.env.ML_SERVICE_TOKEN?.trim();
  if (!token) {
    throw new Error('ML_SERVICE_TOKEN 未配置');
  }
  return token;
}

function internalHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Internal-Token': getToken(),
  };
}

function wrapMlError(error: unknown, action: string): Error {
  if (axios.isAxiosError(error)) {
    const ax = error as AxiosError<{ detail?: string }>;
    const detail = ax.response?.data?.detail;
    const status = ax.response?.status;
    const suffix = detail ? `: ${detail}` : status ? ` (HTTP ${status})` : '';
    return new Error(`ML 服务 ${action} 失败${suffix}`);
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error(`ML 服务 ${action} 失败`);
}

export async function healthCheck(): Promise<MlHealthResult> {
  try {
    const response = await axios.get<MlHealthResult>(`${getBaseUrl()}/internal/health`, {
      timeout: 10_000,
    });
    return response.data;
  } catch (error) {
    throw wrapMlError(error, 'healthCheck');
  }
}

export async function rebuildPrototype(examples: string[]): Promise<RebuildPrototypeResult> {
  if (!examples.length) {
    throw new Error('examples 不能为空');
  }

  try {
    const response = await axios.post<RebuildPrototypeResult>(
      `${getBaseUrl()}/internal/prototype/rebuild`,
      { examples },
      { headers: internalHeaders(), timeout: 120_000 },
    );
    return response.data;
  } catch (error) {
    throw wrapMlError(error, 'rebuildPrototype');
  }
}

export async function classify(
  title: string,
  prototypes?: CategoryPrototypeInput[],
): Promise<ClassifyResult> {
  try {
    const response = await axios.post<ClassifyResult>(
      `${getBaseUrl()}/internal/classify`,
      {
        title,
        categories: prototypes ?? [],
      },
      { headers: internalHeaders(), timeout: 120_000 },
    );
    return response.data;
  } catch (error) {
    throw wrapMlError(error, 'classify');
  }
}

export type TrainAnnotationInput = {
  title: string;
  category_id: number;
  category_code?: string;
};

export type TrainStartResult = {
  job_id: string;
  status: string;
};

export type TrainProgressResult = {
  job_id: string;
  status: string;
  progress: number;
  stage: string | null;
  version: string | null;
  path: string | null;
  metrics: Record<string, unknown> | null;
  error: string | null;
};

export type ReloadModelResult = {
  version: string;
  path: string;
  active: boolean;
};

export async function startTraining(
  jobId: number,
  annotations: TrainAnnotationInput[],
): Promise<TrainStartResult> {
  if (annotations.length < 2) {
    throw new Error('annotations 至少需要 2 条');
  }

  try {
    const response = await axios.post<TrainStartResult>(
      `${getBaseUrl()}/internal/train`,
      { job_id: jobId, annotations },
      { headers: internalHeaders(), timeout: 30_000 },
    );
    return response.data;
  } catch (error) {
    throw wrapMlError(error, 'startTraining');
  }
}

export async function getTrainingProgress(jobId: number): Promise<TrainProgressResult> {
  try {
    const response = await axios.get<TrainProgressResult>(
      `${getBaseUrl()}/internal/train/${jobId}/progress`,
      { headers: internalHeaders(), timeout: 15_000 },
    );
    return response.data;
  } catch (error) {
    throw wrapMlError(error, 'getTrainingProgress');
  }
}

export async function reloadModel(version: string, path: string): Promise<ReloadModelResult> {
  try {
    const response = await axios.post<ReloadModelResult>(
      `${getBaseUrl()}/internal/reload-model`,
      { version, path },
      { headers: internalHeaders(), timeout: 30_000 },
    );
    return response.data;
  } catch (error) {
    throw wrapMlError(error, 'reloadModel');
  }
}
