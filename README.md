# opencode-netz-retry

OpenCode plugin that keeps model requests alive through intermittent network and
DNS failures (for example `Error: getaddrinfo ETIMEDOUT integrate.api.nvidia.com`).

## What it does

Two layers of protection:

1. **In-request retries** — a [`retry` hook](https://opencode.ai/v2/docs/build/plugins/server#retry-policy)
   marks transport/DNS errors of the `nvidia` provider as retryable with an
   exponential backoff (5 s → 20 s). The retry hook runs after OpenCode
   classifies the failure, but the built-in maximum attempt count still applies
   inside one request (see "Limitations" below).

2. **Auto re-prompt after final failure** — when the request still dies on a
   network error after the built-in in-request cap, the plugin waits, then
   re-submits the last user prompt of the failed session until the network
   comes back. The loop stops on success, a manual interrupt, a non-network
   error, or after 120 cycles.

## Install

Add to `~/.config/opencode/opencode.jsonc` (or project config):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/opencode-netz-retry"
  ]
}
```

Options (via the object plugin form):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-netz-retry",
      "options": {
        "delay": 10000,       // pause between auto re-prompts (ms)
        "reprompt": true      // set false to disable layer 2
      }
    }
  ]
}
```

## Behavior and limitations

- Automatic recovery is keyed to the failure class:
  - **network** (`getaddrinfo ETIMEDOUT/EAI_AGAIN`, 429, 500/502/503/504) —
    re-sends the last user message until it succeeds.
  - **content safety screening** (`input rejected by content safety screening`)
    — retrying the same input never succeeds: the provider refuses the whole
    request (history + prompt). The plugin continues the task in a **new
    session** with a sanitized context (excerpts of the last user messages,
    at most 1200 chars each, at most 3 messages) and the same model.
  - **images limit** (`At most 8 image(s) ... --limit-mm-per-prompt`) —
    re-sends the last user message once with a batching hint (max 8 images per
    CLI call).
  - **everything else** (auth, billing, validation, "Function ... Not found") —
    deliberately not retried; the debug log records the classification.
- An optional pause switch stops all automatic recovery immediately:
  `touch /tmp/opencode/netz-retry-paused` (resume: `rm ...`).
- Every auto re-prompt appends a new copy of the user message to the session
  history (this is inherent to re-submitting a prompt); a safety recovery
  creates a new session instead.
- File/image attachments are re-sent as plain text only; only the text part is
  carried over.
- Restriction on layer 1: the built-in retry attempt cap is a hard limit in
  OpenCode; a plugin hook can mark failures as retryable but cannot raise or
  remove the cap (`anomalyco/opencode#60122`). A feature request for a
  configurable limit lives in the linked repository issue.
- Plugin logs go to `~/.local/share/opencode/log/opencode.log` with the
  `[netz-retry]` prefix.

## Diagnosing DNS resilience yourself

A DNS timeout (`getaddrinfo ETIMEDOUT`) is resolved by the operating system
resolver. A local caching resolver (`systemd-resolved`, `nscd`, `dnsmasq`) plus
reliable upstreams (e.g. `1.1.1.1`, `8.8.8.8`) attenuates these errors at the
root and is more effective than any in-app retry.

## License

MIT
