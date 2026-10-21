# Remote model gateways

Status: current
Owner: src/local-llm/gateways/

`ModelGatewayClient` talks to a configured llama-swap host. The host owns model
processes, launch commands, GPU allocation and idle unloading. Atomic does not
download or supervise those processes through its managed-local daemon path.

Catalog and status use `/v1/models` and `/running`. They never probe an upstream
model. Explicit start uses `/upstream/{model}/` and then verifies `ready`; an
upstream root returning 404 does not imply load failure. Stop waits for the unload
operation and verifies the process is absent. A failed host remains unavailable,
not an empty list of stopped models.

Metadata under `meta.llamaswap` supplies kind, native alias, context, vision,
weight size, workspace link, idle policy and exclusive group. Atomic requires
Stop before starting another model in that group. See
[operator configuration](../../../docs/user/model-gateways.md).

Optional metadata `api: openai-compatible` selects the existing OpenAI provider
for main inference. Native models keep `local-llama`; OpenAI gateway mains use
`gateway-main` without replacing the native route or embedding provider.
Selection persists the active provider and Fusion seats together; callers
rebuild the selected provider and activate it in the live registry. Status and
leases continue to use the gateway lifecycle, independent of inference API.

`GatewayTaskManager` owns task leases. The shared runtime prepares providers for
each actual turn, including scheduled turns and pinned Fusion workers. Leases
keep models warm during long tools, honor cancellation, and end with the turn.
Model changes share its operation queue; new turns wait before selecting their
providers, and Stop supersedes an in-flight load. HTTP controls use
`gateway-selection.ts` to persist the main/worker route together and reload the
runtime provider registry. Status polling never acquires a lease. Health lease requests must be configured
as non-autoloading paths so they cannot undo an operator's Stop.

`gateway-target.ts` recognizes only configured gateway URLs. Other external and
cloud providers retain their existing lifecycle.

Checks: adjacent client/task-manager tests, runtime turn-service tests, TUI gateway
and health tests, production/test typechecks and `npm run imports:check`.
