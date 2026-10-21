import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startTestHarness, type Harness } from "./test-harness.js";
import { getConfig } from "../config/index.js";
import { selectGatewayModel } from "../local-llm/gateways/gateway-selection.js";
import { ModelGatewayClient } from "../local-llm/gateways/model-gateway-client.js";

let harness: Harness;
const servers: Server[] = [];
beforeEach(async () => { harness = await startTestHarness({ apiKey: "test-key" }); });
afterEach(async () => {
  await harness?.cleanup();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
const headers = { authorization: "Bearer test-key", "content-type": "application/json" };
async function host(id: string, siblings = false, api?: string) {
  let loaded = false;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: "chat", name: id, meta: { llamaswap: { api, nativeModel: id, parallelSlots: 2, group: "large", chatParams: { temperature: 0.6 } } } }, ...(siblings ? [{ id: "other", meta: { llamaswap: { kind: "llm", group: "large" } } }] : [])] }));
    else if (req.url === "/running") res.end(JSON.stringify({ running: loaded ? [{ model: "chat", state: "ready" }] : [] }));
    else if (req.url === "/upstream/chat/") { loaded = true; res.writeHead(404).end("{}"); }
    else if (req.url?.startsWith("/api/models/unload")) { loaded = false; res.end("{}"); }
    else if (req.url === "/upstream/chat/health") res.writeHead(loaded ? 200 : 409).end("{}");
    else res.writeHead(404).end("{}");
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  return { definition: { id, name: id, url: `http://127.0.0.1:${address.port}`, apiKeyEnv: null }, requests, loaded: () => loaded };
}
async function configure(...hosts: Awaited<ReturnType<typeof host>>[]) {
  const response = await fetch(harness.baseUrl + "/api/config", {
    method: "PATCH", headers, body: JSON.stringify({ localModels: { mode: "external", url: hosts[0]!.definition.url + "/upstream/chat", gateways: hosts.map(host => host.definition) } }),
  });
  expect(response.status).toBe(200);
}
function action(body: unknown) {
  return fetch(harness.baseUrl + "/api/model-gateways", { method: "POST", headers, body: JSON.stringify(body) });
}

it("requires authentication and lists remote models without loading them", async () => {
  const m5 = await host("m5"); await configure(m5);
  expect((await fetch(harness.baseUrl + "/api/model-gateways")).status).toBe(401);
  const response = await fetch(harness.baseUrl + "/api/model-gateways", { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ hosts: [{ models: [{ state: "stopped" }] }] });
  expect(m5.loaded()).toBe(false);
  expect(m5.requests.every(path => path === "GET /v1/models" || path === "GET /running")).toBe(true);
});

it("selects an OpenAI gateway as main, preserves it through Fusion and Solo, and switches back to native", async () => {
  const flash = await host("flash", false, "openai-compatible"), native = await host("native");
  await configure(flash, native);
  expect((await action({ action: "start", hostId: "flash", modelId: "chat", role: "main" })).status).toBe(200);
  expect(getConfig().llm?.activeTextProvider).toBe("gateway-main");
  expect(harness.runtime.providerRegistry.activeTextProviderId).toBe("gateway-main");
  expect(getConfig().llm?.providers.find(p => p.id === "gateway-main")).toMatchObject({
    kind: "openai-compatible", baseUrl: flash.definition.url + "/upstream/chat", defaultChatModel: "flash",
    userModels: [{ params: { cache_prompt: true, temperature: 0.6 } }],
  });
  expect(getConfig().llm?.providers.find(p => p.id === "local-llama")?.kind).toBe("llama-server");
  expect(flash.requests.some(path => /props|slots|apply-template/.test(path))).toBe(false);
  expect((await action({ action: "start", hostId: "native", modelId: "chat", role: "worker" })).status).toBe(200);
  expect(getConfig().llm?.runMode?.fusion?.orchestratorProvider).toBe("gateway-main");
  expect((await action({ action: "solo" })).status).toBe(200);
  expect(getConfig().llm?.activeTextProvider).toBe("gateway-main");
  expect(flash.loaded()).toBe(true); expect(native.loaded()).toBe(false);
  expect((await action({ action: "start", hostId: "native", modelId: "chat", role: "main" })).status).toBe(200);
  expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  expect(harness.runtime.providerRegistry.activeTextProviderId).toBe("local-llama");
});

it("selects the real main and worker routes and returns to Solo without starting a local managed server", async () => {
  const m5 = await host("m5"), wsl = await host("wsl"); await configure(m5, wsl);
  expect((await action({ action: "start", hostId: "m5", modelId: "chat", role: "main" })).status).toBe(200);
  expect(getConfig().localModels.url).toBe(m5.definition.url + "/upstream/chat");
  expect((await action({ action: "start", hostId: "wsl", modelId: "chat", role: "worker" })).status).toBe(200);
  expect(getConfig().llm?.runMode?.mode).toBe("fusion");
  expect(getConfig().llm?.providers.find(provider => provider.id === "gateway-worker")?.userModels?.[0]?.params).toEqual({ cache_prompt: true, temperature: 0.6 });
  expect((await action({ action: "solo" })).status).toBe(200);
  expect(getConfig().localModels.mode).toBe("external");
  expect(getConfig().localModels.url).toBe(m5.definition.url + "/upstream/chat");
  expect(getConfig().llm?.runMode?.mode).toBe("local");
  expect(wsl.loaded()).toBe(false);
});

it("Stop all cancels completions and model task leases before unloading hosts", async () => {
  const m5 = await host("m5"); await configure(m5);
  const lease = await harness.runtime.gatewayTasks.prepare([m5.definition.url + "/upstream/chat"]);
  const controller = new AbortController();
  harness.completionRegistry.register({ completionId: "pending", sessionId: "pending", controller, startedAt: Date.now() });
  try {
    expect((await action({ action: "stop-all" })).status).toBe(200);
    expect(controller.signal.aborted).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(harness.completionRegistry.size()).toBe(0);
    expect(m5.loaded()).toBe(false);
  } finally { lease.release(); }
});

it("a turn arriving during a model change waits and then loads the newly selected host", async () => {
  const m5 = await host("m5"), wsl = await host("wsl"); await configure(m5, wsl);
  const model = (await new ModelGatewayClient(wsl.definition).list())[0]!;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const switching = harness.runtime.gatewayTasks.changeModels(async () => {
    await gate; selectGatewayModel(wsl.definition, model, "main");
  }, undefined);
  const response = await fetch(harness.baseUrl + "/v1/chat/completions", {
    method: "POST", headers, body: JSON.stringify({ model: "local", stream: true, messages: [{ role: "user", content: "Say hello" }] }),
  });
  const text = response.text();
  await vi.waitFor(() => expect(harness.completionRegistry.size()).toBe(1));
  expect(m5.loaded()).toBe(false); expect(wsl.loaded()).toBe(false);
  release(); await switching; await text;
  expect(m5.loaded()).toBe(false); expect(wsl.loaded()).toBe(true);
});

it("allows main and worker sessions to share one M5 model and keeps Fusion on main reselection", async () => {
  const m5 = await host("m5"); await configure(m5);
  expect((await action({ action: "start", hostId: "m5", modelId: "chat", role: "main" })).status).toBe(200);
  expect((await action({ action: "start", hostId: "m5", modelId: "chat", role: "worker" })).status).toBe(200);
  expect(getConfig().llm?.runMode?.mode).toBe("fusion");
  expect(getConfig().llm?.runMode?.fusion?.workers).toBe(2);
  expect((await action({ action: "start", hostId: "m5", modelId: "chat", role: "main" })).status).toBe(200);
  expect(getConfig().llm?.runMode?.mode).toBe("fusion");
  expect(getConfig().llm?.runMode?.fusion?.workers).toBe(2);
  expect((await action({ action: "solo" })).status).toBe(200);
  expect(m5.loaded()).toBe(true);
});

it("refuses a different same-host worker when it conflicts with the main model exclusive group", async () => {
  const m5 = await host("m5", true); await configure(m5);
  const response = await action({action:"start", hostId:"m5", modelId:"other", role:"worker"});
  expect(response.status).toBe(500);
  expect(await response.text()).toContain("exclusive group");
  expect(m5.loaded()).toBe(false);
});
