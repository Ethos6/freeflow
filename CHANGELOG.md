# Changelog

## Unreleased

- Fixed: when a natively forwarded Anthropic response or a `/v1/chat/completions` passthrough failed after the headers were sent (for example on the idle timeout), the failure was not recorded in the activity log or stats, the provider was not put in a cooldown, and the client got a silently truncated 200. Streams now end with an error event in the API's own format, cut-off JSON replies drop the connection, and the attempt counts as a provider failure. ([#7](https://github.com/Ethos6/freeflow/issues/7))

## 1.0.0 (2026-10-20)

First release.

- Anthropic Messages API (`/v1/messages`, streaming and not, `count_tokens`, `models`) on top of 58 providers.
- OpenAI Chat Completions passthrough (`/v1/chat/completions`) with the same routing.
- Routes per Claude tier, direct `provider/model` selection, and ordered fallback chains with per-model reasoning effort.
- Health tracking: provider and model cooldowns, `Retry-After`, exponential backoff.
- Read-ahead fallback before the first token; clean `overloaded_error` if a provider dies mid-answer.
- Self-healing requests that drop parameters a provider rejects, remembered per model.
- Dashboard: providers, model lists, test button, routing editor, live activity, proxy token.
- Launchers for Claude Code, OpenCode and Aider; `freeflow env` for everything else.
- Tests: unit, integration, official SDK conformance, and a real Claude Code end-to-end run.
