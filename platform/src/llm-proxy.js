/**
 * LLM Proxy — routes LLM calls through the platform.
 *
 * The platform holds API keys; agents request completions through
 * WebSocket and the platform proxies to provider APIs.
 *
 * Supported providers: OpenAI, Anthropic, Google, DeepSeek, OpenRouter
 */
import fetch from 'node-fetch';

const PROVIDERS = {
  openai: {
    base: 'https://api.openai.com/v1',
    path: '/chat/completions',
    authHeader: (key) => `Bearer ${key}`,
    bodyFormat: (req) => ({
      model: req.model?.replace('openai/', '') || 'gpt-4o',
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 4096
    }),
    parseResponse: (data) => ({
      content: data.choices?.[0]?.message?.content || '',
      usage: {
        prompt: data.usage?.prompt_tokens || 0,
        completion: data.usage?.completion_tokens || 0,
        total: data.usage?.total_tokens || 0
      },
      model: data.model,
      finishReason: data.choices?.[0]?.finish_reason
    })
  },

  anthropic: {
    base: 'https://api.anthropic.com/v1',
    path: '/messages',
    authHeader: (key) => key,
    headers: { 'anthropic-version': '2023-06-01', 'x-api-key': null }, // set dynamically
    bodyFormat: (req) => {
      // Convert OpenAI-style messages to Anthropic format
      const systemMsg = req.messages.find(m => m.role === 'system');
      const messages = req.messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
      return {
        model: req.model?.replace('anthropic/', '') || 'claude-sonnet-4-20250514',
        max_tokens: req.maxTokens ?? 4096,
        system: systemMsg?.content || '',
        messages
      };
    },
    authHeaderFn: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    parseResponse: (data) => ({
      content: data.content?.[0]?.text || '',
      usage: {
        prompt: data.usage?.input_tokens || 0,
        completion: data.usage?.output_tokens || 0,
        total: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
      },
      model: data.model,
      finishReason: data.stop_reason
    })
  },

  google: {
    base: 'https://generativelanguage.googleapis.com/v1beta',
    pathFn: (req) => `/models/${req.model?.replace('google/', '') || 'gemini-2.5-flash'}:generateContent`,
    authParam: (key) => `key=${key}`,
    bodyFormat: (req) => {
      const systemMsg = req.messages.find(m => m.role === 'system');
      const contents = req.messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      return {
        system_instruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
        contents,
        generationConfig: {
          temperature: req.temperature ?? 0.7,
          maxOutputTokens: req.maxTokens ?? 4096
        }
      };
    },
    parseResponse: (data) => ({
      content: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
      usage: {
        prompt: data.usageMetadata?.promptTokenCount || 0,
        completion: data.usageMetadata?.candidatesTokenCount || 0,
        total: data.usageMetadata?.totalTokenCount || 0
      },
      model: data.modelVersion,
      finishReason: data.candidates?.[0]?.finishReason
    })
  },

  deepseek: {
    base: 'https://api.deepseek.com/v1',
    path: '/chat/completions',
    authHeader: (key) => `Bearer ${key}`,
    bodyFormat: (req) => ({
      model: req.model?.replace('deepseek/', '') || 'deepseek-chat',
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 4096
    }),
    parseResponse: (data) => ({
      content: data.choices?.[0]?.message?.content || '',
      usage: {
        prompt: data.usage?.prompt_tokens || 0,
        completion: data.usage?.completion_tokens || 0,
        total: data.usage?.total_tokens || 0
      },
      model: data.model,
      finishReason: data.choices?.[0]?.finish_reason
    })
  },

  openrouter: {
    base: 'https://openrouter.ai/api/v1',
    path: '/chat/completions',
    authHeader: (key) => `Bearer ${key}`,
    bodyFormat: (req) => ({
      model: req.model?.replace('openrouter/', '') || 'openai/gpt-4o',
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 4096
    }),
    parseResponse: (data) => ({
      content: data.choices?.[0]?.message?.content || '',
      usage: {
        prompt: data.usage?.prompt_tokens || 0,
        completion: data.usage?.completion_tokens || 0,
        total: data.usage?.total_tokens || 0
      },
      model: data.model,
      finishReason: data.choices?.[0]?.finish_reason
    })
  }
};

export class LLMProxy {
  /**
   * Make an LLM API call through the platform.
   */
  static async call(vault, { provider, model, messages, temperature, maxTokens, keyId }) {
    // The platform decides the provider — devices never name one.
    if (!provider) {
      if (model && model.includes('/')) {
        const parts = model.split('/');
        provider = parts[0];
        model = parts.slice(1).join('/');
      } else {
        provider = 'openai'; // default
      }
    }

    const providerConfig = PROVIDERS[provider?.toLowerCase()];
    if (!providerConfig) {
      throw new Error(`Unsupported provider: ${provider}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
    }

    // Get API key from vault
    let keyEntry;
    if (keyId) {
      keyEntry = vault.get(keyId);
    } else {
      keyEntry = vault.getForProvider(provider);
    }

    if (!keyEntry) {
      throw new Error(`No API key found for provider "${provider}". Add one in Settings → API Keys.`);
    }

    const url = providerConfig.pathFn
      ? `${providerConfig.base}${providerConfig.pathFn({ model })}${providerConfig.authParam ? `?${providerConfig.authParam(keyEntry.key)}` : ''}`
      : `${providerConfig.base}${providerConfig.path}`;

    const body = providerConfig.bodyFormat({ model, messages, temperature, maxTokens });

    const headers = {
      'Content-Type': 'application/json',
      ...(providerConfig.authHeaderFn
        ? providerConfig.authHeaderFn(keyEntry.key)
        : { 'Authorization': providerConfig.authHeader(keyEntry.key) }),
      ...(providerConfig.headers || {})
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000) // 2 min timeout
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data.error?.message || data.error?.code || `HTTP ${response.status}`;
      throw new Error(`${provider} API error: ${errMsg}`);
    }

    return providerConfig.parseResponse(data);
  }
}
