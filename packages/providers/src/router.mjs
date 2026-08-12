import { providerError, forbidden, notFound, dayKey } from '@mona/core';

/**
 * Routing engine.
 *
 * This is the only place in the platform where a provider credential is decrypted,
 * and it is decrypted into a local variable that is passed to one adapter call and
 * then dropped. It is never attached to a request context, never returned, never
 * logged, and never crosses a serialisation boundary.
 */
export class RoutingEngine {
  constructor({ registry, repos, keyring, config, log }) {
    this.registry = registry;
    this.repos = repos;
    this.keyring = keyring;
    this.config = config;
    this.log = log;
  }

  /** Resolve an agent's configured provider + model, honouring its routing policy. */
  async resolve(agent, { modelOverride = null } = {}) {
    const model = await this.repos.models.byId(modelOverride || agent.model_id);
    if (!model) throw notFound('That model is no longer available.');
    if (!model.enabled) throw providerError('That model has been disabled by an administrator.');

    const provider = await this.repos.providers.byId(model.provider_id);
    if (!provider) throw notFound('The provider for that model is no longer configured.');
    if (!provider.enabled) throw providerError(`${provider.name} is disabled on this platform.`);
    if (!this.registry.has(provider.slug)) throw providerError(`No adapter is loaded for ${provider.name}.`);

    // An override must still be a model the agent is allowed to use.
    if (modelOverride && modelOverride !== agent.model_id) {
      const allowed = await this.repos.db.get(
        'SELECT 1 AS ok FROM agent_models WHERE agent_id = ? AND model_id = ?', [agent.id, modelOverride]);
      if (!allowed) throw forbidden('This agent is not permitted to use that model.');
    }
    return { provider, model, adapter: this.registry.get(provider.slug) };
  }

  /**
   * Fetch and decrypt the credential for one call.
   * @returns {Promise<{secret:string|null, credentialId:string|null}>}
   */
  async #credential(userId, provider) {
    const adapter = this.registry.get(provider.slug);
    if (!adapter.requiresCredential || !provider.requires_credential) return { secret: null, credentialId: null };

    const row = await this.repos.providerCredentials.activeSecretFor(userId, provider.id);
    if (!row) {
      throw forbidden(`No active ${provider.name} key is stored for this account. Add one under Security → Provider keys.`);
    }
    const secret = this.keyring.decrypt(row.secret_enc, { purpose: 'provider_credential', aad: `${userId}:${provider.id}` });
    return { secret, credentialId: row.id };
  }

  /** Cost in EUR from the model's per-million-token prices. Zero when unpriced. */
  static cost(model, usage) {
    const inPrice = Number(model.input_price_per_mtok || 0);
    const outPrice = Number(model.output_price_per_mtok || 0);
    return ((usage.inputTokens || 0) * inPrice + (usage.outputTokens || 0) * outPrice) / 1e6;
  }

  #buildRequest({ agent, model, messages, secret, signal, maxTokensOverride }) {
    return {
      model: model.slug,
      messages,
      system: agent.system_prompt || null,
      temperature: Number(agent.temperature),
      maxTokens: Math.min(maxTokensOverride || agent.max_tokens, model.max_output || agent.max_tokens),
      credential: secret,
      agentName: agent.name,
      signal,
    };
  }

  async chat({ agent, userId, messages, modelOverride = null, maxTokensOverride = null, signal = null }) {
    const { provider, model, adapter } = await this.resolve(agent, { modelOverride });
    const { secret, credentialId } = await this.#credential(userId, provider);
    const started = Date.now();
    try {
      const result = await adapter.chat(this.#buildRequest({ agent, model, messages, secret, signal, maxTokensOverride }));
      if (credentialId) await this.repos.providerCredentials.markUsed(credentialId);
      return { ...result, provider, model, cost: RoutingEngine.cost(model, result.usage), latencyMs: result.latencyMs ?? Date.now() - started };
    } catch (err) {
      await this.repos.providers.recordHealth(provider.id, err.status >= 500 ? 'degraded' : 'operational', Date.now() - started);
      throw err;
    }
  }

  /**
   * Streaming call. Yields adapter chunks unchanged plus a final `meta` chunk carrying
   * the resolved provider, model, usage and cost so the caller can persist one record.
   */
  async *stream({ agent, userId, messages, modelOverride = null, maxTokensOverride = null, signal = null }) {
    const { provider, model, adapter } = await this.resolve(agent, { modelOverride });
    const { secret, credentialId } = await this.#credential(userId, provider);
    const started = Date.now();
    let usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason = 'stop';
    let firstTokenAt = null;

    try {
      for await (const chunk of adapter.stream(this.#buildRequest({ agent, model, messages, secret, signal, maxTokensOverride }))) {
        if (chunk.type === 'delta' && firstTokenAt === null) firstTokenAt = Date.now();
        if (chunk.type === 'usage') { usage = chunk.usage; continue; }
        if (chunk.type === 'done') { finishReason = chunk.finishReason || finishReason; continue; }
        yield chunk;
      }
      if (credentialId) await this.repos.providerCredentials.markUsed(credentialId);
      yield {
        type: 'meta',
        provider: provider.slug,
        providerName: provider.name,
        model: model.slug,
        modelId: model.id,
        simulated: provider.kind === 'simulated',
        usage,
        finishReason,
        latencyMs: Date.now() - started,
        firstTokenMs: firstTokenAt ? firstTokenAt - started : null,
        cost: RoutingEngine.cost(model, usage),
      };
    } catch (err) {
      await this.repos.providers.recordHealth(provider.id, err.status >= 500 ? 'degraded' : 'operational', Date.now() - started);
      throw err;
    }
  }

  /** Verify a user-supplied key against the live provider before it is stored. */
  async verifyCredential(providerSlug, secret) {
    const adapter = this.registry.get(providerSlug);
    if (!adapter.requiresCredential) return { ok: true, detail: `${adapter.name} does not use a key.` };
    try { return await adapter.authenticate(secret); }
    catch (e) { return { ok: false, detail: e.message }; }
  }

  async healthAll() {
    const rows = await this.repos.providers.all();
    const out = [];
    for (const p of rows) {
      if (!this.registry.has(p.slug)) { out.push({ slug: p.slug, status: 'not_configured', latencyMs: null }); continue; }
      const adapter = this.registry.get(p.slug);
      if (adapter.requiresCredential) { out.push({ slug: p.slug, status: p.status || 'unknown', latencyMs: p.latency_ms }); continue; }
      const h = await adapter.healthCheck();
      await this.repos.providers.recordHealth(p.id, h.status, h.latencyMs);
      out.push({ slug: p.slug, ...h });
    }
    return out;
  }

  /** One place to write everything a completed call produces. */
  async record({ requestId, userId, agentId, deviceId, route, status, latencyMs, usage, providerSlug, modelSlug, errorCode = null, ip = null, userAgent = null, cost = 0 }) {
    const tokens = (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
    await this.repos.apiRequests.record({
      id: requestId, user_id: userId, agent_id: agentId, device_id: deviceId, method: 'POST', route,
      status, latency_ms: latencyMs, provider_slug: providerSlug, model_slug: modelSlug,
      input_tokens: usage?.inputTokens || 0, output_tokens: usage?.outputTokens || 0,
      error_code: errorCode, ip, user_agent: (userAgent || '').slice(0, 200),
    });
    await this.repos.usage.roll({
      userId, agentId, day: dayKey(), providerSlug, modelSlug,
      inputTokens: usage?.inputTokens || 0, outputTokens: usage?.outputTokens || 0,
      errors: status >= 400 ? 1 : 0, latencyMs, cost,
    });
    if (agentId) await this.repos.agents.recordTraffic(agentId, { tokens, errors: status >= 400 ? 1 : 0, latencyMs });
  }
}
