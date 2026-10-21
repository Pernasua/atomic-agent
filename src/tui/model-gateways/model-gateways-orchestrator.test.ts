import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, getUserConfigPath, resetConfigCache, USER_CONFIG_DEFAULTS, writeUserConfigFileSync } from "../../config/index.js";
import type { ModelGatewayDefinition } from "../../local-llm/gateways/model-gateway-types.js";
import type { TuiAction } from "../tui-action.js";
import { persistUserLocalLlmUrl } from "../persist-user-local-models-config.js";
import { GatewayTaskManager } from "../../local-llm/gateways/gateway-task-manager.js";
import { ModelGatewaysOrchestrator } from "./model-gateways-orchestrator.js";

describe("Atomic remote model controls", () => {
  let directory: string;
  let originalDirectory: string | undefined;
  const servers: Server[] = [];
  const managers: ModelGatewaysOrchestrator[] = [];
  const taskManagers: GatewayTaskManager[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "atomic-gateway-controls-"));
    originalDirectory = process.env.ATOMIC_AGENT_STATE_DIR;
    process.env.ATOMIC_AGENT_STATE_DIR = directory;
    resetConfigCache();
  });

  afterEach(async () => {
    for (const manager of taskManagers.splice(0)) manager.close();
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections(); server.close(() => resolve());
    })));
    if (originalDirectory === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR;
    else process.env.ATOMIC_AGENT_STATE_DIR = originalDirectory;
    resetConfigCache();
    rmSync(directory, { recursive: true, force: true });
  });

  async function host(id: string, slow = false, chatParams?: Record<string, unknown>, api?: string) {
    const requests: string[] = [];
    let phase: "starting" | "ready" | null = null;
    let generation = 0;
    const server = createServer((request, response) => {
      const path = request.url ?? "";
      requests.push(`${request.method} ${path}`);
      response.setHeader("Content-Type", "application/json");
      if (path === "/v1/models") response.end(JSON.stringify({ data: [{ id: "chat", name: `${id} chat`, meta: { llamaswap: { api, chatParams } } }] }));
      else if (path === "/running") response.end(JSON.stringify({ running: phase ? [{ model: "chat", state: phase }] : [] }));
      else if (path === "/upstream/chat/") {
        phase = "starting";
        const started = ++generation;
        setTimeout(() => {
          if (generation === started) phase = "ready";
          response.writeHead(404).end("{}");
        }, slow ? 80 : 1);
      } else if (path.startsWith("/api/models/unload")) {
        generation++; phase = null; response.end("{}");
      } else response.writeHead(404).end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener");
    const definition: ModelGatewayDefinition = { id, name: id, url: `http://127.0.0.1:${address.port}`, apiKeyEnv: null };
    return { definition, requests, phase: () => phase };
  }

  function setup(hosts: ModelGatewayDefinition[], turn = new AbortController()) {
    const file = structuredClone(USER_CONFIG_DEFAULTS);
    file.localModels.gateways = hosts;
    file.localModels.url = `${hosts[0]!.url}/upstream/chat`;
    file.llm = {
      activeTextProvider: "local-llama", activeEmbeddingProvider: "local-llama", toolTransport: "auto",
      providers: [{ id: "local-llama", kind: "llama-server", url: file.localModels.url }],
    };
    if (hosts[1]) {
      file.llm.providers.push({ id: "gateway-worker", kind: "openai-compatible", baseUrl: `${hosts[1].url}/upstream/chat`, defaultChatModel: "chat" });
      file.llm.runMode = { mode: "fusion", fusion: { orchestratorProvider: "local-llama", workerProvider: "gateway-worker", workers: 1, cloudWorkers: 1 } };
    }
    writeUserConfigFileSync(getUserConfigPath(directory), file);
    resetConfigCache();
    const events: TuiAction[] = [];
    const gatewayTasks = new GatewayTaskManager({ gateways: () => getConfig().localModels.gateways });
    taskManagers.push(gatewayTasks);
    const manager = new ModelGatewaysOrchestrator({ emit: (event) => events.push(event) }, {
      activate: async (url) => { persistUserLocalLlmUrl(url); return true; },
      isBusy: () => false,
      abortTasks: () => turn.abort(),
      runtime: {
        reloadLlmProvider: async () => {}, reloadLlmProviders: async () => {}, refreshLocalModelProfile: async () => {},
        providerRegistry: { setActive: async () => {} },
        gatewayTasks,
      },
      refreshProviders: () => {},
    });
    managers.push(manager);
    return { manager, events, gatewayTasks };
  }

  it("opening and refreshing the controls does not load a model", async () => {
    const m5 = await host("m5");
    const { manager, events } = setup([m5.definition]);
    await manager.refresh();
    await manager.refresh();
    expect(m5.phase()).toBeNull();
    expect(m5.requests.some((path) => path.includes("/upstream/"))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "llm_gateways_refreshed", hosts: [expect.objectContaining({ online: true })] }));
  });

  it("starts the selected main and worker only when a user turn needs them", async () => {
    const m5 = await host("m5"), pc = await host("pc");
    const { gatewayTasks } = setup([m5.definition, pc.definition]);
    expect(m5.phase()).toBeNull(); expect(pc.phase()).toBeNull();
    const first = await gatewayTasks.prepare([m5.definition.url + "/upstream/chat", pc.definition.url + "/upstream/chat"]);
    expect(m5.phase()).toBe("ready"); expect(pc.phase()).toBe("ready");
    first.release();
    const second = await gatewayTasks.prepare([m5.definition.url + "/upstream/chat", pc.definition.url + "/upstream/chat"]);
    second.release();
    expect(m5.requests.filter((path) => path === "GET /upstream/chat/")).toHaveLength(1);
    expect(pc.requests.filter((path) => path === "GET /upstream/chat/")).toHaveLength(1);
  });

  it("switching main to the worker model shares that endpoint and retains Fusion", async () => {
    const m5 = await host("m5"), pc = await host("pc");
    const { manager } = setup([m5.definition, pc.definition]);
    await manager.use("pc", "chat");
    expect(pc.phase()).toBe("ready");
    expect(getConfig().localModels.url).toBe(`${pc.definition.url}/upstream/chat`);
    expect(getConfig().llm?.runMode?.mode).toBe("fusion");
  });

  it("worker selection carries the model's inference settings into its provider", async () => {
    const chatParams = { temperature: 0.6, chat_template_kwargs: { enable_thinking: true }, cache_prompt: true };
    const m5 = await host("m5"), pc = await host("pc", false, chatParams);
    const { manager } = setup([m5.definition, pc.definition]);
    await manager.useWorker("pc", "chat");
    const worker = getConfig().llm?.providers.find((provider) => provider.id === "gateway-worker");
    expect(worker?.userModels?.[0]?.params).toEqual(chatParams);
    expect(worker?.baseUrl).toBe(`${pc.definition.url}/upstream/chat`);
    expect(getConfig().llm?.runMode?.mode).toBe("fusion");
  });

  it("uses OpenAI transport for a gateway main and preserves it through Fusion and Solo", async () => {
    const native = await host("native"), flash = await host("flash", false, {}, "openai-compatible");
    const { manager } = setup([native.definition, flash.definition]);
    await manager.use("flash", "chat");
    expect(getConfig().llm?.activeTextProvider).toBe("gateway-main");
    expect(getConfig().localModels.url).toBe(`${native.definition.url}/upstream/chat`);
    expect(getConfig().llm?.providers.find(p => p.id === "gateway-main")?.baseUrl).toBe(`${flash.definition.url}/upstream/chat`);
    await manager.useWorker("flash", "chat");
    expect(getConfig().llm?.runMode?.fusion?.orchestratorProvider).toBe("gateway-main");
    await manager.toggleFusion();
    expect(getConfig().llm?.activeTextProvider).toBe("gateway-main");
    expect(flash.phase()).toBe("ready");
  });

  it("Stop all cancels a pending start and leaves every host unloaded", async () => {
    const m5 = await host("m5", true);
    const turn = new AbortController();
    const { manager, gatewayTasks } = setup([m5.definition], turn);
    const pending = gatewayTasks.prepare([m5.definition.url + "/upstream/chat"], turn.signal).catch(() => {});
    await vi.waitFor(() => expect(m5.phase()).toBe("starting"));
    await manager.stopAll();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await manager.refresh();
    expect(turn.signal.aborted).toBe(true);
    expect(m5.phase()).toBeNull();
    expect(m5.requests.filter((path) => path === "GET /upstream/chat/")).toHaveLength(1);
  });
});
