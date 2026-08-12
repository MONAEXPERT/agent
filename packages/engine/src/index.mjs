export * from './sse.mjs';
export * from './engine.mjs';
export * from './simulated.mjs';

import { EngineClient } from './engine.mjs';
import { SimulatedEngine } from './simulated.mjs';

/**
 * Engine factory. One brain, two modes:
 *   simulated — offline dev/CI (never allowed in production)
 *   remote    — the real mona.expert engine (one key: the mona.expert key)
 */
export function createEngine(cfg, { log = null } = {}) {
  if (cfg.engine.mode === 'simulated') return new SimulatedEngine({ log });
  return new EngineClient({ url: cfg.engine.url, key: cfg.engine.key, timeoutMs: cfg.engine.timeoutMs, log });
}
