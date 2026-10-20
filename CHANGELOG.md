# Changelog

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
