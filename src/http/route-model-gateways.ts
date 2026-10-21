import { getConfig } from "../config/index.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-registry.js";
import { resolveRunMode } from "../llm/run-mode/index.js";
import { ModelGatewayClient } from "../local-llm/gateways/model-gateway-client.js";
import { findGatewayTarget } from "../local-llm/gateways/gateway-target.js";
import { gatewayWorkerProvider } from "../local-llm/gateways/gateway-worker-provider.js";
import { gatewayMainUrl, selectGatewayModel, selectGatewaySolo } from "../local-llm/gateways/gateway-selection.js";
import { readJsonBody, sendJson, type HttpHandler } from "./request-context.js";
import type { GatewayModel } from "../local-llm/gateways/model-gateway-types.js";
import type { UserLlmProviderEntry } from "../config/llm-config.js";

type ActionResult = { cancelled: true } | { ok: false; errors: string[] } | {
  ok: true; model?: GatewayModel; url?: string; workerProvider?: UserLlmProviderEntry | null;
};

export function createModelGatewayHandlers(): { list: HttpHandler; action: HttpHandler } {
  const list: HttpHandler = async (_req, res, ctx) => {
    const config = getConfig();
    const providers = resolveLlmConfig(config);
    const mode = resolveRunMode(providers);
    const active = providers.providers.find(provider => provider.id === providers.activeTextProvider);
    const worker = providers.providers.find(provider => provider.id === mode.workerProviderId);
    const main = findGatewayTarget(active?.kind === "llama-server" ? config.localModels.url : active?.baseUrl ?? "", config.localModels.gateways);
    const workerTarget = findGatewayTarget(worker?.baseUrl ?? "", config.localModels.gateways);
    const hosts = await Promise.all(config.localModels.gateways.map(async gateway => {
      try { return { gateway, online: true, models: await new ModelGatewayClient(gateway).list(), error: null }; }
      catch (error) { return { gateway, online: false, models: [], error: error instanceof Error ? error.message : String(error) }; }
    }));
    sendJson(res, 200, {
      hosts, mode: mode.effective, busy: ctx.runtime.gatewayTasks.controlsBusy,
      externalWorkers: { active: ctx.localWorkers?.activeCount??0, queued: ctx.localWorkers?.pendingCount??0 },
      main: main ? { hostId: main.gateway.id, modelId: main.modelId } : null,
      worker: workerTarget ? { hostId: workerTarget.gateway.id, modelId: workerTarget.modelId } : null,
    });
  };
  const action: HttpHandler = async (req, res, ctx) => {
    const body = await readJsonBody<unknown>(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) { sendJson(res, 400, { error: { message: "Expected a model action" } }); return; }
    const { action, hostId, modelId, role } = body as Record<string, unknown>;
    if (!["start", "stop", "stop-all", "solo"].includes(String(action))) { sendJson(res, 400, { error: { message: "Unknown model action" } }); return; }
    const config = getConfig();
    if (action === "stop-all") {
      ctx.completionRegistry.cancelAll();
      ctx.runtime.gatewayTasks.cancelAll();
      const result = await ctx.runtime.gatewayTasks.changeModels<ActionResult>(async signal => {
        await ctx.localWorkers?.cancelAll();
        const results = await Promise.allSettled(config.localModels.gateways.map(gateway => new ModelGatewayClient(gateway).stopAll(signal)));
        const failures = results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
        return failures.length ? { ok: false, errors: failures } : { ok: true };
      }, { cancelled: true });
      sendJson(res, 200, result); return;
    }
    if (action === "solo") {
      if ((ctx.localWorkers?.activeCount??0)>0 || ctx.runtime.gatewayTasks.activeCount > 0 || ctx.completionRegistry.size() > 0) { sendJson(res, 409, { error: { message: "Stop the running task before changing modes" } }); return; }
      const result = await ctx.runtime.gatewayTasks.changeModels<ActionResult>(async signal => {
        const providers = resolveLlmConfig(getConfig());
        const worker = providers.providers.find(provider => provider.id === resolveRunMode(providers).workerProviderId);
        const target = worker?.baseUrl ? findGatewayTarget(worker.baseUrl, getConfig().localModels.gateways) : null;
        selectGatewaySolo();
        await ctx.runtime.reloadLlmProviders();
        const main = findGatewayTarget(gatewayMainUrl(), getConfig().localModels.gateways);
        if (target && (target.gateway.id !== main?.gateway.id || target.modelId !== main.modelId)) await new ModelGatewayClient(target.gateway).stop(target.modelId, signal);
        return { ok: true };
      }, { cancelled: true });
      sendJson(res, 200, result); return;
    }
    const gateway = config.localModels.gateways.find(host => host.id === hostId);
    if (!gateway || typeof modelId !== "string") { sendJson(res, 400, { error: { message: "Choose a configured host and model" } }); return; }
    if (action === "start" && ((ctx.localWorkers?.activeCount??0)>0 || ctx.completionRegistry.size() > 0 || ctx.runtime.gatewayTasks.activeCount > 0)) {
      sendJson(res, 409, { error: { message: "Stop the running task before changing its models" } }); return;
    }
    if (action === "stop") ctx.runtime.gatewayTasks.cancelModel(gateway.id, modelId);
    const result = await ctx.runtime.gatewayTasks.changeModels<ActionResult>(async signal => {
      if (action === "stop") await ctx.localWorkers?.cancelFor(gateway.id, modelId);
      const client = new ModelGatewayClient(gateway);
      const models = await client.list(signal);
      const model = models.find(row => row.id === modelId);
      if (!model) throw new Error("The model is not installed on this host");
      if (action === "stop") { await client.stop(modelId, signal); return { ok: true }; }
      if (role === "worker") {
        if (model.kind !== "llm") throw new Error("Choose a chat model for the worker");
        const main = findGatewayTarget(gatewayMainUrl(), config.localModels.gateways);
        if (!main) throw new Error("Choose a main model first");
        const mainModel = main.gateway.id === gateway.id ? models.find(row => row.id === main.modelId) : undefined;
        if (mainModel && mainModel.id !== model.id && model.group && model.group === mainModel.group) throw new Error("Main and worker models share an exclusive group; share the main model or choose a compatible model");
      }
      await client.start(modelId, signal); signal.throwIfAborted();
      if (model.kind === "llm") {
        selectGatewayModel(gateway, model, role === "worker" ? "worker" : "main", models);
        const providerId = role === "worker" ? "gateway-worker" : getConfig().llm!.activeTextProvider;
        await ctx.runtime.reloadLlmProvider(providerId);
        if (role !== "worker") await ctx.runtime.providerRegistry.setActive(providerId);
        if (role !== "worker" && model.api !== "openai-compatible") await ctx.runtime.refreshLocalModelProfile();
        signal.throwIfAborted();
      }
      return { ok: true, model, url: client.inferenceUrl(modelId), workerProvider: model.kind === "llm" ? gatewayWorkerProvider(gateway, model) : null };
    }, { cancelled: true });
    sendJson(res, 200, result);
  };
  return { list, action };
}
