import { ensureUserConfigFileSync, getConfig, parseUserConfigFile, resetConfigCache, writeUserConfigFileSync } from "../../config/index.js";
import { readLlmBlockOrDefault } from "../../config/llm-provider-commands.js";
import { findGatewayTarget } from "./gateway-target.js";
import { gatewayWorkerProvider } from "./gateway-worker-provider.js";
import type { GatewayModel, ModelGatewayDefinition } from "./model-gateway-types.js";

/** Persist the route together with its provider and Fusion seats. */
export function selectGatewayModel(gateway: ModelGatewayDefinition, model: GatewayModel, role: "main" | "worker", peers: readonly GatewayModel[] = []): void {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  const url = `${gateway.url}/upstream/${encodeURIComponent(model.id)}`;
  let mainId = llm.activeTextProvider;
  if (role === "main") {
    mainId = model.api === "openai-compatible" ? "gateway-main" : "local-llama";
    if (model.api === "openai-compatible") {
      llm.providers = [...llm.providers.filter(provider => provider.id !== mainId),
        { ...gatewayWorkerProvider(gateway, model), id: mainId }];
    } else {
      file.localModels = { ...file.localModels, mode: "external", url };
      const old = llm.providers.find(provider => provider.id === mainId);
      llm.providers = [...llm.providers.filter(provider => provider.id !== mainId),
        { ...old, id: mainId, kind: "llama-server", url, model: model.nativeModel }];
    }
    const soloMode = model.api === "openai-compatible" ? "cloud" : "local";
    const worker = llm.providers.find(provider => provider.id === llm.runMode?.fusion?.workerProvider);
    const workerHost = worker?.baseUrl ? findGatewayTarget(worker.baseUrl, file.localModels.gateways) : null;
    const workerModel = peers.find(peer => peer.id === workerHost?.modelId);
    if (llm.runMode?.mode === "fusion" && workerHost?.gateway.id === gateway.id &&
        workerHost.modelId !== model.id && (!workerModel || (!!model.group && model.group === workerModel.group))) llm.runMode = { ...llm.runMode, mode: soloMode };
    else if (llm.runMode?.mode === "fusion") llm.runMode = { ...llm.runMode, fusion: { ...llm.runMode.fusion, orchestratorProvider: mainId } };
    else llm.runMode = { ...llm.runMode, mode: soloMode };
  } else {
    llm.providers = [...llm.providers.filter(provider => provider.id !== "gateway-worker"), gatewayWorkerProvider(gateway, model)];
    const workers = Math.max(1, Math.min(8, model.parallelSlots ?? 1));
    llm.runMode = { mode: "fusion", fusion: { orchestratorProvider: mainId, workerProvider: "gateway-worker", workers, cloudWorkers: workers } };
  }
  llm.activeTextProvider = mainId;
  file.llm = llm;
  writeUserConfigFileSync(path, parseUserConfigFile(file));
  resetConfigCache();
}

export function selectGatewaySolo(): void {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  const main = llm.providers.find(provider => provider.id === llm.activeTextProvider);
  llm.runMode = { ...llm.runMode, mode: main?.kind === "openai-compatible" ? "cloud" : "local" };
  file.llm = llm;
  writeUserConfigFileSync(path, parseUserConfigFile(file));
  resetConfigCache();
}

export function gatewayMainUrl(): string {
  const config = getConfig();
  const main = config.llm?.providers.find(provider => provider.id === config.llm?.activeTextProvider);
  return main?.kind === "openai-compatible" ? main.baseUrl ?? "" : config.localModels.url;
}
