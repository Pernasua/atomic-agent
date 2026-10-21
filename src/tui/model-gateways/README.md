# Gateway model controls

Status: current
Owner: src/tui/model-gateways/

The Gateways pane of Manage → LLM displays each host's catalog and live state.
Keyboard and mouse share one handler. The panel uses the existing row window
and preserves selection across catalog refreshes.

`ModelGatewaysOrchestrator` owns UI refresh and serialized operator actions.
Native main activation shares the External pane's activation flow and refreshes
the runtime profile. OpenAI main activation uses the gateway's API metadata and
existing OpenAI provider. Both persist selection through the gateway domain and
activate the resulting live provider. Worker selection uses an independent OpenAI-compatible provider
and the existing Fusion settings owner, avoiding a second native provider that
silently shares the main model's text client.

Process ownership and turn leases belong to the [gateway domain](../../local-llm/gateways/README.md)
and runtime. Stop all cancels runtime gateway tasks and queued TUI work before
unloading hosts. Offline hosts remain unavailable. Media/decision models start
without replacing the main chat route.

Checks: adjacent orchestration/presentation tests, LLM panel and gateway health
tests, runtime tests, production/test typechecks and documentation/import checks.
