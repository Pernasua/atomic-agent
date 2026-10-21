import { setTimeout as delay } from "node:timers/promises";
import type {
  GatewayModel,
  GatewayModelState,
  ModelGatewayDefinition,
} from "./model-gateway-types.js";

interface ClientOptions {
  requestTimeoutMs?: number;
  loadTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface RunningModel {
  model: string;
  state: GatewayModelState;
  ttl: number | null;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid gateway ${label}`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid gateway ${label}`);
  return value;
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** llama-swap owns processes; status requests must never touch an upstream model. */
export class ModelGatewayClient {
  private readonly requestTimeoutMs: number;
  private readonly loadTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    readonly gateway: ModelGatewayDefinition,
    options: ClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 300_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
  }

  inferenceUrl(modelId: string): string {
    return `${this.gateway.url.replace(/\/+$/, "")}/upstream/${encodeURIComponent(modelId)}`;
  }

  async list(signal?: AbortSignal): Promise<GatewayModel[]> {
    const [catalog, running] = await Promise.all([
      this.json("/v1/models", signal),
      this.running(signal),
    ]);
    return array(object(catalog, "catalog").data, "model list").map((raw) => {
      const model = object(raw, "model");
      const id = string(model.id);
      if (!id) throw new Error("Gateway returned a model without an id");
      const meta = model.meta ? object(model.meta, "metadata") : {};
      const details = meta.llamaswap ? object(meta.llamaswap, "model metadata") : {};
      const kvCache = details.kvCache ? object(details.kvCache, "KV cache metadata") : null;
      const process = running.find((entry) => entry.model === id);
      return {
        id,
        name: string(model.name, id),
        description: string(model.description),
        kind: string(details.kind, "llm"),
        group: typeof details.group === "string" ? details.group : null,
        nativeModel: string(details.nativeModel, id),
        ...(details.api === "openai-compatible" ? { api: "openai-compatible" as const } : {}),
        state: process?.state ?? "stopped",
        contextSize: number(details.contextSize),
        parallelSlots: Number.isInteger(details.parallelSlots) && Number(details.parallelSlots) >= 1 && Number(details.parallelSlots) <= 32 ? Number(details.parallelSlots) : 1,
        ...(typeof kvCache?.k === "string" && typeof kvCache.v === "string" ? { kvCache: { k: kvCache.k, v: kvCache.v } } : {}),
        ...(typeof details.runtime === "string" ? { runtime: details.runtime } : {}),
        supportsVision: details.supportsVision === true,
        sizeBytes: number(details.sizeBytes),
        workspacePath: typeof details.workspacePath === "string" ? details.workspacePath : null,
        ttlSeconds: number(details.ttlSeconds) ?? process?.ttl ?? null,
        chatParams: details.chatParams == null ? undefined : object(details.chatParams, "model chat parameters"),
      };
    });
  }

  async start(modelId: string, signal?: AbortSignal): Promise<void> {
    const models = await this.list(signal);
    const selected = models.find((model) => model.id === modelId);
    if (!selected) throw new Error(`${this.gateway.name}: model ${modelId} is not installed`);
    const competing = selected.group ? models.find((model) => model.id !== modelId &&
      model.group === selected.group && ["ready", "starting", "stopping"].includes(model.state)) : null;
    if (competing) {
      throw new Error(`Stop ${competing.name} on ${this.gateway.name} before starting ${selected.name}; they share the same model slot.`);
    }
    // This is llama-swap's explicit-load operation, also used by its own UI.
    // A model's root page may return 404 even though its inference server is ready.
    const response = await this.request(
      `/upstream/${encodeURIComponent(modelId)}/`, "GET", signal, this.loadTimeoutMs,
    );
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) {
      throw new Error(`${this.gateway.name}: model start failed (HTTP ${response.status})`);
    }
    await this.waitFor(
      (running) => running.some((row) => row.model === modelId && row.state === "ready"),
      this.loadTimeoutMs,
      `model ${modelId} did not become ready`,
      signal,
    );
  }

  async stop(modelId: string, signal?: AbortSignal): Promise<void> {
    await this.unload(`/api/models/unload/${encodeURIComponent(modelId)}`, signal);
    await this.waitFor(
      (running) => !running.some((row) => row.model === modelId),
      this.stopTimeoutMs,
      `model ${modelId} is still running after Stop`,
      signal,
    );
  }

  async stopAll(signal?: AbortSignal): Promise<void> {
    await this.unload("/api/models/unload", signal);
    await this.waitFor(
      (running) => running.length === 0,
      this.stopTimeoutMs,
      "models are still running after Stop all",
      signal,
    );
  }

  /** A running task may keep its models warm; this route must not autoload a stopped model. */
  async keepAlive(modelId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(`/upstream/${encodeURIComponent(modelId)}/health`, "GET", signal);
    await response.body?.cancel();
    if (!response.ok) throw new Error(`${this.gateway.name}: model task lease failed (HTTP ${response.status})`);
  }

  private async unload(path: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(path, "POST", signal, this.stopTimeoutMs);
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(`${this.gateway.name}: model unload failed (HTTP ${response.status})`);
    }
  }

  private async running(signal?: AbortSignal): Promise<RunningModel[]> {
    const result = object(await this.json("/running", signal), "running response");
    return array(result.running, "running models").map((raw) => {
      const entry = object(raw, "running model");
      if (typeof entry.model !== "string" ||
          !["stopped", "starting", "ready", "stopping", "failed"].includes(string(entry.state))) {
        throw new Error("Gateway returned an invalid process state");
      }
      return {
        model: entry.model,
        state: entry.state as GatewayModelState,
        ttl: number(entry.ttl),
      };
    });
  }

  private async waitFor(
    satisfied: (models: RunningModel[]) => boolean,
    timeoutMs: number,
    message: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (satisfied(await this.running(signal))) return;
      if (Date.now() >= deadline) throw new Error(`${this.gateway.name}: ${message}`);
      await delay(this.pollIntervalMs, undefined, { signal });
    }
  }

  private async json(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(path, "GET", signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${this.gateway.name}: status unavailable (HTTP ${response.status})`);
    }
    return response.json();
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    signal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.gateway.apiKeyEnv) {
      const key = process.env[this.gateway.apiKeyEnv];
      if (!key) throw new Error(`${this.gateway.name}: gateway credential is not configured`);
      headers.Authorization = `Bearer ${key}`;
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await fetch(`${this.gateway.url.replace(/\/+$/, "")}${path}`, {
        method,
        headers,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`${this.gateway.name}: gateway is unreachable or timed out`, { cause: error });
    }
  }
}
