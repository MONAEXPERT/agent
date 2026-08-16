// Structured local memory: scored recall, near-duplicate dedupe, TTL, pruning.
//
// The agent that remembers everything useful and forgets everything stale.
// Entries carry a creation time and optional tags; recall scores by
// keyword overlap plus recency decay. Near-duplicates are merged instead
// of appended, so memory stays dense instead of bloated.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_STORE = process.env.MONA_MEMORY_STORE || join(homedir(), '.mona-agent', 'memory-store.json');
const MAX_ENTRIES = 500;
const DEFAULT_TTL_DAYS = 30;
const DEDUPE_THRESHOLD = 0.85;

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const set = new Set(a);
  let hits = 0;
  for (const w of b) if (set.has(w)) hits++;
  return hits / Math.min(a.length, b.length);
}

export class MemoryStore {
  constructor({ storePath = DEFAULT_STORE, maxEntries = MAX_ENTRIES } = {}) {
    this.storePath = storePath;
    this.maxEntries = maxEntries;
    this.entries = [];
    this.#load();
  }

  #load() {
    try {
      if (existsSync(this.storePath)) {
        const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
        if (Array.isArray(raw.entries)) this.entries = raw.entries;
      }
    } catch { /* corrupt → start empty */ }
  }

  #save() {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify({ entries: this.entries }, null, 2), { mode: 0o600 });
    } catch { /* best-effort */ }
  }

  remember(text, { ttlDays = DEFAULT_TTL_DAYS, tags = [] } = {}) {
    const body = String(text || '').trim();
    if (!body) return null;
    const tokens = normalize(body);

    // Dedupe: if an existing entry is nearly identical, refresh it instead.
    for (const e of this.entries) {
      if (overlap(tokens, normalize(e.text)) >= DEDUPE_THRESHOLD) {
        e.text = body;
        e.createdAt = Date.now();
        e.ttlDays = ttlDays;
        e.tags = tags;
        e.hits = (e.hits || 0) + 1;
        this.#save();
        return e;
      }
    }

    const entry = {
      id: `mem_${Math.random().toString(36).slice(2, 10)}`,
      text: body,
      tags: Array.isArray(tags) ? tags : [],
      ttlDays,
      createdAt: Date.now(),
      hits: 1,
    };
    this.entries.push(entry);
    this.prune();
    this.#save();
    return entry;
  }

  /** Score = keyword overlap with the query + recency decay + hit boost. */
  recall(query, { limit = 8 } = {}) {
    const q = normalize(query);
    const now = Date.now();
    const results = [];
    for (const e of this.entries) {
      const toks = normalize(e.text);
      const overlapScore = q.length ? overlap(q, toks) : 0;
      if (q.length && overlapScore === 0) continue;
      const ageDays = (now - e.createdAt) / 86400000;
      if (ageDays > (e.ttlDays || DEFAULT_TTL_DAYS)) continue;
      const recency = Math.max(0, 1 - ageDays / (e.ttlDays || DEFAULT_TTL_DAYS));
      const score = (q.length ? overlapScore * 0.6 : 0.3) + recency * 0.3 + Math.min(0.1, (e.hits || 1) * 0.02);
      results.push({ text: e.text, score, ageDays, tags: e.tags, createdAt: e.createdAt });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Drop expired entries and cap the total count. */
  prune() {
    const now = Date.now();
    this.entries = this.entries.filter((e) => (now - e.createdAt) / 86400000 <= (e.ttlDays || DEFAULT_TTL_DAYS));
    if (this.entries.length > this.maxEntries) {
      this.entries.sort((a, b) => (b.hits || 1) - (a.hits || 1) || a.createdAt - b.createdAt);
      this.entries = this.entries.slice(0, this.maxEntries);
    }
    return this.entries.length;
  }

  stats() {
    return { entries: this.entries.length, maxEntries: this.maxEntries };
  }
}
