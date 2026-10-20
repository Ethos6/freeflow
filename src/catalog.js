// @ts-check
/**
 * The provider catalog: every upstream freeflow knows how to reach.
 *
 * Entries are plain data. Behaviour differences between providers are described
 * by a small set of `quirks` flags that the translator and router read, so adding
 * a provider never needs new code paths.
 *
 * tier:
 *   "free"  - the provider advertises a free tier or free models (limits are theirs and change)
 *   "plan"  - a subscription / coding plan
 *   "paid"  - pay as you go
 *   "local" - runs on your own machine
 */

/**
 * @typedef {object} Quirks
 * @property {"max_tokens"|"max_completion_tokens"} [maxTokensField]
 * @property {"effort"|"openrouter"} [reasoning]     How to ask for reasoning effort, if at all.
 * @property {boolean} [echoReasoning]                Send prior reasoning back as `reasoning_content`.
 * @property {"alnum9"} [toolIdStyle]                 Provider-imposed tool call id format.
 * @property {boolean} [thoughtSignatures]           Gemini: keep and replay tool-call thought signatures.
 * @property {boolean} [noStreamUsage]               Do not send stream_options.include_usage.
 *
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} name
 * @property {"free"|"plan"|"paid"|"local"} tier
 * @property {string} base             Default OpenAI-compatible base URL (or Anthropic base for native).
 * @property {string} [env]            Environment variable read for the key.
 * @property {string} [keyUrl]         Where to create a key.
 * @property {string} [example]        Example model id at this provider.
 * @property {boolean} [keyOptional]   Works without a key (local servers, anonymous tiers).
 * @property {"openai"|"anthropic"} [format]
 * @property {string[]} [needs]        Extra settings required, e.g. ["baseUrl"], ["accountId"].
 * @property {string} [note]
 * @property {Quirks} [quirks]
 */

/** @type {Provider[]} */
export const PROVIDERS = [
  // ---- free tiers and free models ------------------------------------------------
  { id: "nvidia", name: "NVIDIA NIM", tier: "free", base: "https://integrate.api.nvidia.com/v1", env: "NVIDIA_NIM_API_KEY", keyUrl: "https://build.nvidia.com/settings/api-keys", example: "nvidia/nemotron-3-super-120b-a12b" },
  { id: "openrouter", name: "OpenRouter", tier: "free", base: "https://openrouter.ai/api/v1", env: "OPENROUTER_API_KEY", keyUrl: "https://openrouter.ai/keys", example: "openrouter/free", note: "Model ids ending in :free cost nothing.", quirks: { reasoning: "openrouter" } },
  { id: "groq", name: "Groq", tier: "free", base: "https://api.groq.com/openai/v1", env: "GROQ_API_KEY", keyUrl: "https://console.groq.com/keys", example: "llama-3.3-70b-versatile" },
  { id: "gemini", name: "Google AI Studio (Gemini)", tier: "free", base: "https://generativelanguage.googleapis.com/v1beta/openai", env: "GEMINI_API_KEY", keyUrl: "https://aistudio.google.com/apikey", example: "gemini-3.1-flash-lite", quirks: { reasoning: "effort", thoughtSignatures: true } },
  { id: "cerebras", name: "Cerebras", tier: "free", base: "https://api.cerebras.ai/v1", env: "CEREBRAS_API_KEY", keyUrl: "https://cloud.cerebras.ai", example: "gpt-oss-120b" },
  { id: "sambanova", name: "SambaNova", tier: "free", base: "https://api.sambanova.ai/v1", env: "SAMBANOVA_API_KEY", keyUrl: "https://cloud.sambanova.ai/apis", example: "Meta-Llama-3.3-70B-Instruct" },
  { id: "mistral", name: "Mistral La Plateforme", tier: "free", base: "https://api.mistral.ai/v1", env: "MISTRAL_API_KEY", keyUrl: "https://console.mistral.ai/", example: "devstral-small-latest", quirks: { toolIdStyle: "alnum9" } },
  { id: "codestral", name: "Mistral Codestral", tier: "free", base: "https://codestral.mistral.ai/v1", env: "CODESTRAL_API_KEY", keyUrl: "https://console.mistral.ai/", example: "codestral-latest", note: "Uses a separate key from La Plateforme.", quirks: { toolIdStyle: "alnum9" } },
  { id: "cohere", name: "Cohere", tier: "free", base: "https://api.cohere.ai/compatibility/v1", env: "COHERE_API_KEY", keyUrl: "https://dashboard.cohere.com/api-keys", example: "command-a-plus-05-2026" },
  { id: "huggingface", name: "Hugging Face Inference", tier: "free", base: "https://router.huggingface.co/v1", env: "HUGGINGFACE_API_KEY", keyUrl: "https://huggingface.co/settings/tokens", example: "Qwen/Qwen3-Coder-480B-A35B-Instruct:fastest" },
  { id: "cloudflare", name: "Cloudflare Workers AI", tier: "free", base: "https://api.cloudflare.com/client/v4", env: "CLOUDFLARE_API_TOKEN", keyUrl: "https://dash.cloudflare.com/profile/api-tokens", example: "@cf/moonshotai/kimi-k2.6", needs: ["accountId"], note: "Needs your account id as well as an API token." },
  { id: "ollama-cloud", name: "Ollama Cloud", tier: "free", base: "https://ollama.com/v1", env: "OLLAMA_API_KEY", keyUrl: "https://ollama.com/settings/keys", example: "qwen3-coder:480b" },
  { id: "opencode-zen", name: "OpenCode Zen", tier: "free", base: "https://opencode.ai/zen/v1", env: "OPENCODE_API_KEY", keyUrl: "https://opencode.ai/auth", example: "gpt-5.3-codex" },
  { id: "kilo", name: "Kilo.ai Gateway", tier: "free", base: "https://api.kilo.ai/api/gateway", env: "KILO_API_KEY", keyUrl: "https://app.kilo.ai", example: "kilo-auto/free" },
  { id: "zenmux", name: "ZenMux", tier: "free", base: "https://zenmux.ai/api/v1", env: "ZENMUX_API_KEY", keyUrl: "https://zenmux.ai/platform/pay-as-you-go", example: "deepseek/deepseek-v4-flash-free" },
  { id: "llm7", name: "LLM7.io", tier: "free", base: "https://api.llm7.io/v1", env: "LLM7_API_KEY", keyUrl: "https://dash.llm7.io/", example: "default", keyOptional: true },
  { id: "tokenrouter", name: "TokenRouter", tier: "free", base: "https://api.tokenrouter.com/v1", env: "TOKENROUTER_API_KEY", keyUrl: "https://www.tokenrouter.com/", example: "moonshotai/kimi-k3-free" },
  { id: "nararoute", name: "NaraRoute", tier: "free", base: "https://router.bynara.id/v1", env: "NARAROUTE_API_KEY", keyUrl: "https://router.bynara.id/keys", example: "kimi-k3-free" },
  { id: "orcarouter", name: "OrcaRouter", tier: "free", base: "https://api.orcarouter.ai/v1", env: "ORCAROUTER_API_KEY", keyUrl: "https://www.orcarouter.ai/console", example: "deepseek/deepseek-v4-flash-free" },
  { id: "xkiro", name: "xKiro", tier: "free", base: "https://api.xkiro.com/v1", env: "XKIRO_API_KEY", keyUrl: "https://xkiro.com/dashboard/api/keys", example: "qwen/qwen3.7-flash:free" },
  { id: "scaleway", name: "Scaleway Generative APIs", tier: "free", base: "https://api.scaleway.ai/v1", env: "SCW_SECRET_KEY", keyUrl: "https://console.scaleway.com/iam/api-keys", example: "deepseek/deepseek-v4-flash" },

  // ---- subscriptions and coding plans -------------------------------------------
  { id: "cline", name: "ClinePass", tier: "plan", base: "https://api.cline.bot/api/v1", env: "CLINE_API_KEY", keyUrl: "https://app.cline.bot", example: "cline-pass/kimi-k3" },
  { id: "kimi-code", name: "Kimi Code", tier: "plan", base: "https://api.kimi.com/coding/v1", env: "KIMI_CODE_API_KEY", keyUrl: "https://www.kimi.com/code/console", example: "k3", note: "For personal, interactive coding-agent use.", quirks: { echoReasoning: true } },
  { id: "zai-coding", name: "Z.ai Coding Plan", tier: "plan", base: "https://api.z.ai/api/coding/paas/v4", env: "ZAI_API_KEY", keyUrl: "https://z.ai/manage-apikey/apikey-list", example: "glm-5.2", quirks: { echoReasoning: true } },
  { id: "qwen-coding", name: "QwenCloud Coding Plan", tier: "plan", base: "https://coding-intl.dashscope.aliyuncs.com/v1", env: "QWENCLOUD_CODING_API_KEY", keyUrl: "https://home.qwencloud.com/api-keys", example: "qwen3.7-plus", note: "For local, personal, interactive coding-agent use." },
  { id: "qwen-tokens", name: "QwenCloud Token Plan", tier: "plan", base: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", env: "QWENCLOUD_API_KEY", keyUrl: "https://home.qwencloud.com/api-keys", example: "qwen3.7-plus" },
  { id: "opencode-go", name: "OpenCode Go", tier: "plan", base: "https://opencode.ai/zen/go/v1", env: "OPENCODE_API_KEY", keyUrl: "https://opencode.ai/auth", example: "minimax-m2.7" },
  { id: "wafer", name: "Wafer Pass", tier: "plan", base: "https://pass.wafer.ai/v1", env: "WAFER_API_KEY", keyUrl: "https://www.wafer.ai/pass", example: "DeepSeek-V4-Pro" },

  // ---- pay as you go ---------------------------------------------------------------
  { id: "anthropic", name: "Anthropic", tier: "paid", base: "https://api.anthropic.com", env: "ANTHROPIC_API_KEY", keyUrl: "https://platform.claude.com/settings/keys", example: "claude-sonnet-4-6", format: "anthropic", note: "Forwarded natively, with no translation." },
  { id: "openai", name: "OpenAI API", tier: "paid", base: "https://api.openai.com/v1", env: "OPENAI_API_KEY", keyUrl: "https://platform.openai.com/api-keys", example: "gpt-5.6-sol", quirks: { maxTokensField: "max_completion_tokens", reasoning: "effort" } },
  { id: "azure", name: "Azure OpenAI", tier: "paid", base: "", env: "AZURE_OPENAI_API_KEY", keyUrl: "https://ai.azure.com/", example: "<deployment-name>", needs: ["baseUrl"], note: "Set the base URL to https://RESOURCE.openai.azure.com/openai/v1", quirks: { maxTokensField: "max_completion_tokens", reasoning: "effort" } },
  { id: "xai", name: "xAI (Grok)", tier: "paid", base: "https://api.x.ai/v1", env: "XAI_API_KEY", keyUrl: "https://console.x.ai/", example: "grok-4.5" },
  { id: "deepseek", name: "DeepSeek", tier: "paid", base: "https://api.deepseek.com/v1", env: "DEEPSEEK_API_KEY", keyUrl: "https://platform.deepseek.com/api_keys", example: "deepseek-chat", quirks: { echoReasoning: true } },
  { id: "kimi", name: "Kimi API (Moonshot)", tier: "paid", base: "https://api.moonshot.ai/v1", env: "KIMI_API_KEY", keyUrl: "https://platform.moonshot.ai/console/api-keys", example: "kimi-k2.5", quirks: { echoReasoning: true } },
  { id: "zai", name: "Z.ai API", tier: "paid", base: "https://api.z.ai/api/paas/v4", env: "ZAI_API_KEY", keyUrl: "https://z.ai/manage-apikey/apikey-list", example: "glm-4.7-flash", quirks: { echoReasoning: true } },
  { id: "minimax", name: "MiniMax", tier: "paid", base: "https://api.minimax.io/v1", env: "MINIMAX_API_KEY", keyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key", example: "MiniMax-M3" },
  { id: "alibaba", name: "Alibaba Cloud Model Studio", tier: "paid", base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", env: "ALIBABA_CLOUD_API_KEY", keyUrl: "https://www.alibabacloud.com/help/en/model-studio/get-api-key", example: "qwen3.7-plus", note: "Defaults to Singapore; the key and base URL must be the same region." },
  { id: "together", name: "Together AI", tier: "paid", base: "https://api.together.ai/v1", env: "TOGETHER_API_KEY", keyUrl: "https://api.together.ai/settings/api-keys", example: "zai-org/GLM-5.2" },
  { id: "deepinfra", name: "DeepInfra", tier: "paid", base: "https://api.deepinfra.com/v1/openai", env: "DEEPINFRA_API_KEY", keyUrl: "https://deepinfra.com/dash/api_keys", example: "deepseek-ai/DeepSeek-V4-Flash" },
  { id: "fireworks", name: "Fireworks AI", tier: "paid", base: "https://api.fireworks.ai/inference/v1", env: "FIREWORKS_API_KEY", keyUrl: "https://fireworks.ai/account/api-keys", example: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
  { id: "novita", name: "Novita AI", tier: "paid", base: "https://api.novita.ai/openai/v1", env: "NOVITA_API_KEY", keyUrl: "https://novita.ai/settings/key-management", example: "deepseek/deepseek-v4-flash-0731" },
  { id: "siliconflow", name: "SiliconFlow", tier: "paid", base: "https://api.siliconflow.com/v1", env: "SILICONFLOW_API_KEY", keyUrl: "https://cloud.siliconflow.com/account/ak", example: "Qwen/Qwen3-32B" },
  { id: "nebius", name: "Nebius Token Factory", tier: "paid", base: "https://api.tokenfactory.nebius.com/v1", env: "NEBIUS_API_KEY", keyUrl: "https://tokenfactory.nebius.com/project/api-keys", example: "Qwen/Qwen3-30B-A3B" },
  { id: "chutes", name: "Chutes", tier: "paid", base: "https://llm.chutes.ai/v1", env: "CHUTES_API_KEY", keyUrl: "https://chutes.ai/", example: "Qwen/Qwen3-32B-TEE" },
  { id: "featherless", name: "Featherless AI", tier: "paid", base: "https://api.featherless.ai/v1", env: "FEATHERLESS_API_KEY", keyUrl: "https://featherless.ai/account/api-keys", example: "Qwen/Qwen3-32B" },
  { id: "vercel", name: "Vercel AI Gateway", tier: "paid", base: "https://ai-gateway.vercel.sh/v1", env: "AI_GATEWAY_API_KEY", keyUrl: "https://vercel.com/docs/ai-gateway", example: "openai/gpt-5.5" },
  { id: "bedrock", name: "Amazon Bedrock", tier: "paid", base: "https://bedrock-mantle.us-east-1.api.aws/v1", env: "AWS_BEARER_TOKEN_BEDROCK", keyUrl: "https://console.aws.amazon.com/bedrock/", example: "openai.gpt-oss-120b", note: "Change the base URL to the region your key belongs to." },
  { id: "wandb", name: "W&B Inference", tier: "paid", base: "https://api.inference.wandb.ai/v1", env: "WANDB_API_KEY", keyUrl: "https://wandb.ai/settings", example: "openai/gpt-oss-20b" },
  { id: "agnes", name: "Agnes AI", tier: "paid", base: "https://apihub.agnes-ai.com/v1", env: "AGNES_API_KEY", keyUrl: "https://agnes-ai.com/", example: "agnes-2.0-flash" },
  { id: "poolside", name: "Poolside AI", tier: "paid", base: "https://inference.poolside.ai/v1", env: "POOLSIDE_API_KEY", keyUrl: "https://platform.poolside.ai/", example: "poolside/laguna-s-2.1" },
  { id: "lightning", name: "Lightning AI", tier: "paid", base: "https://lightning.ai/api/v1", env: "LIGHTNING_API_KEY", keyUrl: "https://lightning.ai/", example: "lightning-ai/Qwen3.8-27B" },
  { id: "experiential", name: "Experiential Labs", tier: "paid", base: "https://api.experientiallabs.ai/v1", env: "EXPLABS_API_KEY", keyUrl: "https://platform.experientiallabs.ai/", example: "union-alpha" },
  { id: "cheaperinference", name: "Cheaper Inference", tier: "paid", base: "https://api.cheaperinference.com/v1", env: "CHEAPER_INFERENCE_API_KEY", keyUrl: "https://cheaperinference.com/signup", example: "gpt-5.4-mini" },
  { id: "atlascloud", name: "Atlas Cloud", tier: "paid", base: "https://api.atlascloud.ai/v1", env: "ATLASCLOUD_API_KEY", keyUrl: "https://console.atlascloud.ai/api-keys", example: "deepseek-ai/deepseek-v4-flash" },
  { id: "opper", name: "Opper", tier: "paid", base: "https://api.opper.ai/v3/compat", env: "OPPER_API_KEY", keyUrl: "https://platform.opper.ai/", example: "claude-sonnet-4-6" },

  // ---- local -------------------------------------------------------------------------
  { id: "ollama", name: "Ollama", tier: "local", base: "http://localhost:11434/v1", keyOptional: true, example: "qwen3-coder" },
  { id: "lmstudio", name: "LM Studio", tier: "local", base: "http://localhost:1234/v1", keyOptional: true, example: "<loaded-model>" },
  { id: "llamacpp", name: "llama.cpp server", tier: "local", base: "http://localhost:8080/v1", keyOptional: true, example: "<model>" },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/** @param {string} id */
export function getProvider(id) {
  return BY_ID.get(id);
}

/**
 * Split "provider/model" at the first slash. The model part may contain more slashes.
 * @param {string} ref
 * @returns {{provider: string, model: string} | null}
 */
export function parseModelRef(ref) {
  if (typeof ref !== "string") return null;
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}
