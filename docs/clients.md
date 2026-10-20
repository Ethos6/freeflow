# Connecting clients

freeflow serves two APIs on `http://127.0.0.1:4141`:

| API | Base URL | Model names |
| --- | --- | --- |
| Anthropic Messages | `http://127.0.0.1:4141` | Claude names (`claude-sonnet-4-6`, …) are mapped to your routes; any `provider/model` is used directly |
| OpenAI Chat Completions | `http://127.0.0.1:4141/v1` | `default` (your default route), a tier name, or any `provider/model` |

The API key can be anything, unless you turned on the proxy token in the dashboard; then use that token.

The launchers (`freeflow claude`, `freeflow opencode`, `freeflow aider`) start freeflow automatically. For other clients, make sure it is running first: `freeflow start`, or `freeflow open`, which also opens the dashboard.

## Claude Code

```bash
freeflow claude                       # uses your routes
freeflow claude --model groq/llama-3.3-70b-versatile
```

Inside a session, `/model nvidia/qwen/qwen3-coder-480b-a35b-instruct` switches models for the rest of the session.

**Always on, including the VS Code and JetBrains extensions.** Add this to `~/.claude/settings.json` so every Claude Code session goes through freeflow:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4141",
    "ANTHROPIC_AUTH_TOKEN": "freeflow"
  }
}
```

Remove the block to go back to your normal Claude login.

## OpenCode

`freeflow opencode` passes a provider definition through `OPENCODE_CONFIG_CONTENT`. To configure it permanently, add to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "freeflow": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "freeflow",
      "options": { "baseURL": "http://127.0.0.1:4141/v1", "apiKey": "freeflow" },
      "models": { "default": { "name": "freeflow default route" } }
    }
  },
  "model": "freeflow/default"
}
```

## Aider

```bash
freeflow aider                                     # model openai/default
freeflow aider --model openai/cerebras/gpt-oss-120b
```

Manually: `OPENAI_API_BASE=http://127.0.0.1:4141/v1 OPENAI_API_KEY=freeflow aider --model openai/default`.

## Cline, Roo Code, Kilo Code

Choose the **OpenAI Compatible** provider and set:

- Base URL: `http://127.0.0.1:4141/v1`
- API key: `freeflow` (or your proxy token)
- Model ID: `default`, or a specific `provider/model`

## Continue

```yaml
models:
  - name: freeflow
    provider: openai
    model: default
    apiBase: http://127.0.0.1:4141/v1
    apiKey: freeflow
```

## Any shell tool

```bash
eval "$(freeflow env)"                  # bash / zsh
freeflow env --shell fish | source      # fish
freeflow env | Invoke-Expression        # PowerShell
```

This sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_BASE_URL`, `OPENAI_API_BASE` and `OPENAI_API_KEY`.

## SDKs and curl

```python
from anthropic import Anthropic
client = Anthropic(base_url="http://127.0.0.1:4141", api_key="freeflow")
print(client.messages.create(model="claude-sonnet-4-6", max_tokens=200,
      messages=[{"role": "user", "content": "Hello"}]).content[0].text)
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:4141/v1", api_key="freeflow")
print(client.chat.completions.create(model="default",
      messages=[{"role": "user", "content": "Hello"}]).choices[0].message.content)
```

```bash
curl http://127.0.0.1:4141/v1/messages -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'
```

Every response carries an `x-freeflow-model` header naming the provider and model that answered.
