# Model gateways

Status: current
Owner: Atomic gateway fork maintainers

Atomic controls models on several machines. Each host runs a lightweight
llama-swap gateway with its existing model files and inference executables.
Only requested model processes consume GPU memory.

## Use the hub

In the GUI, click the model name below the chat box to open **Models**. Each host
shows its installed models, status, and **Start & use**, **Worker** and **Stop**
actions. **Use Solo** disables the worker; **Stop all** cancels tasks and unloads
reachable hosts. The GUI uses the same controller through the browser bridge
described in [the desktop guide](../../desktop/README.md#private-browser-hub).

The terminal remains available: open `/model`, then **Gateways** under Manage →
LLM. Configured gateway routes select this pane automatically. Keyboard controls:

- **Enter / Start:** load the selected model. Chat models also become the main
  agent model; other kinds keep the chat route unchanged.
- **s / Stop:** stop the model and runtime tasks using it.
- **w / Worker:** use a compatible chat model as the Fusion worker, including
  the main model on the same host.
- **f / Solo/Fusion:** toggle the helper. Solo unloads the helper.
- **X / Stop all:** cancel active gateway tasks and queued chat work, then unload
  each reachable host. Unavailable hosts are not counted as stopped.
- **r / Refresh:** refresh status without loading a model.

Multiple agents can share one loaded model through its inference slots.
Different models in the same exclusive group require Stop before another starts. This
prevents a chat request from silently replacing an image/video render. Starting,
ready, stopped and offline are distinct states. Closing the browser does not end
a task; completed turns release their leases and the host's idle policy applies.
A new user or scheduled turn can reload its selected model.

## Connect a host

Add hosts to `localModels.gateways` in Atomic's config. A URL can be an SSH forward
over Tailscale; it addresses the gateway root, not an individual model route.

```json
{
  "localModels": {
    "mode": "external",
    "url": "http://127.0.0.1:18990/upstream/main-model",
    "gateways": [
      {"id": "model-host", "name": "Model host", "url": "http://127.0.0.1:18990"}
    ]
  }
}
```

Optional `apiKeyEnv` names a credential in Atomic's environment/secret file.
Keep credentials out of URLs, and host profiles/weights outside the source repo.

This integration is validated against llama-swap v262. Preserve each model's
working executable, arguments and files. Only one manager may own its processes.
For ten-minute idle unloading, use `globalTTL: 600`, no startup preloads, and:

```yaml
upstream:
  ignorePaths:
    - '^/.+'
```

The model root remains the explicit load operation. Requests to stopped upstream
inference, health, properties and template paths cannot autoload them. Actual turn
preparation loads models; status refreshes do not. Gateway status monitoring must
not poll upstream model endpoints.

Add optional `metadata` to each gateway model:

```yaml
metadata:
  kind: llm
  nativeModel: My model alias
  group: large
  contextSize: 32768
  supportsVision: true
  sizeBytes: 20000000000
  ttlSeconds: 600
```

The picker displays `contextSize` as the model's context limit. Keep it and the
gateway capability's `context` aligned with the runtime's `--ctx-size`. Verify
the effective `/props` and `/slots` after a change: a runtime may cap the requested
size at the model's training limit. Loading a large window and answering a short
prompt checks allocation and serving; it does not measure quality over a full
window.

Other kinds include `image`, `video` and `decision`. `workspacePath` can contain
the full private URL of an existing workspace. `group` names models sharing an
exclusive slot; match it to the gateway's actual routing policy.

For an OpenAI-compatible runtime such as oMLX, set `metadata.api` to
`openai-compatible`. Start & use then selects Atomic's OpenAI provider for the
main model, including its tools and sampling parameters. Omit this field for
llama.cpp. The native llama.cpp route and embedding provider are retained when
selecting an OpenAI gateway. Fusion, Solo, Stop and idle leases use the selected
gateway endpoint in either case.

For an OpenAI-compatible worker, optional `metadata.chatParams` carries the
model's request settings into Atomic's existing per-model `params` field. Use it
for sampling, prompt caching or template options required by that model; for
example `{ "temperature": 0.6, "cache_prompt": true,
"chat_template_kwargs": { "enable_thinking": true } }`. Main native inference
retains Atomic's native generation controls.

## Asynchronous media jobs

An sd.cpp HTTP request finishes while generation continues, and an open preview
polls even when generation is idle. Its HTTP traffic is not an idle clock.
`scripts/gateways/media-idle.py` runs that server with a job-aware idle timer.
Set the gateway model's `ttl` to zero and metadata `ttlSeconds` to the adapter's
idle interval. Keep the worker in the gateway's process group; do not daemonize it.

The adapter waits for queued/generating work to finish before counting idle time.
It terminates and reaps the worker on expiry or Stop. Results held only in server
memory disappear on unload; download media you want to retain.

## Privacy and updates

Gateways need no public listener. SSH forwards and private Tailscale HTTPS routes
connect the hub and workspaces. `captureBuffer: 0` disables request/response
capture; omit persistent metric storage and keep model output out of log files.
Atomic conversations and memory remain in its state folder.

The weekly GitHub Actions workflow merges upstream main and the latest stable desktop release into an update branch, runs the
test workflow against it, and opens or updates a review PR. Conflicts and failed
checks produce a draft. It never connects to or deploys model hosts.
`automation/upstream-sync` belongs to that workflow; make human changes on the
custom branch or a separate working branch.

Review and merge before deploying. Preserve model profiles and verify cold start,
Stop, idle expiry, switching and a real Fusion task when changing runtimes.

## Deploy a reviewed upstream update

The installed hub stays on its current build until you deploy. On the hub host,
with a clean checkout of your custom branch:

```sh
git pull --ff-only
npm ci
npm run lint
npm run typecheck:tests
npm run imports:check
npm run docs:check
npm test
npm run build
npm ci --prefix desktop
npm run build --prefix desktop
npm run test:unit --prefix desktop
```

Restart the GUI controller after its current tasks finish, using your process
manager. Use the same state folder and only one controller; do not leave a
terminal runtime active against that folder during the GUI cutover.
The gateways and model weights do not need to restart for an Atomic-only update.
Keep machine-specific gateway configuration and service definitions outside this
checkout. If the change updates gateway protocols or launch profiles, repeat the
cold-start, Stop, idle and Fusion checks before making it the active build.

For Codex and Claude Code delegation, see [local workers](local-workers.md).
