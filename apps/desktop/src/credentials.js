import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const SERVICE = 'mona-agent';

function validate(value) {
  if (!value || typeof value !== 'object' || typeof value.apiKey !== 'string' || !value.apiKey.trim()) {
    throw new Error('credentials require a non-empty apiKey');
  }
  return { apiKey: value.apiKey, agentId: value.agentId || null };
}

export function memoryBackend() {
  let value = null;
  return {
    name: 'memory', secure: true,
    available: () => true,
    load: () => value ? { ...value } : null,
    save: (_service, _account, next) => { value = { ...next }; },
    clear: () => { value = null; },
  };
}

export function fileBackend(file) {
  return {
    name: 'file', secure: false,
    available: () => true,
    load: () => {
      if (!existsSync(file)) return null;
      try { return validate(JSON.parse(readFileSync(file, 'utf8'))); } catch { return null; }
    },
    save: (_service, _account, value) => {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify(validate(value), null, 2), { mode: 0o600 });
    },
    clear: () => { try { unlinkSync(file); } catch {} },
  };
}

export function createCredentialStore({
  homeDir = homedir(),
  os = platform(),
  backend,
  allowFileFallback = true,
  now = () => new Date().toISOString(),
} = {}) {
  const dir = join(homeDir, '.mona-agent');
  const legacy = join(dir, 'credentials.json');
  const metadataFile = join(dir, 'credentials.meta.json');
  const selected = backend || (allowFileFallback ? fileBackend(legacy) : null);
  if (!selected) throw new Error(`No credential backend available for ${os}`);
  const readMeta = () => {
    try { return JSON.parse(readFileSync(metadataFile, 'utf8')); } catch { return null; }
  };
  const writeMeta = (extra = {}) => {
    mkdirSync(dir, { recursive: true });
    const meta = { schemaVersion: 1, backend: selected.name, secure: selected.secure === true, updatedAt: now(), ...extra };
    writeFileSync(metadataFile, JSON.stringify(meta, null, 2), { mode: 0o600 });
    return meta;
  };
  return {
    load() { return selected.load(SERVICE, os); },
    save(value) {
      const safe = validate(value);
      selected.save(SERVICE, os, safe);
      writeMeta({ agentId: safe.agentId, createdAt: readMeta()?.createdAt || now(), rotatedAt: now() });
      return this.metadata();
    },
    clear() { selected.clear(SERVICE, os); try { unlinkSync(metadataFile); } catch {} },
    metadata() {
      const meta = readMeta();
      if (!meta) return { backend: selected.name, secure: selected.secure === true, present: Boolean(this.load()) };
      return { ...meta, present: Boolean(this.load()), expired: Boolean(meta.expiresAt && Date.parse(meta.expiresAt) <= Date.now()) };
    },
    migrateLegacy() {
      if (selected.name === 'file' || !existsSync(legacy)) return false;
      const value = fileBackend(legacy).load();
      if (!value) return false;
      selected.save(SERVICE, os, value);
      if (!selected.load(SERVICE, os)) throw new Error('credential migration read-back failed');
      writeMeta({ agentId: value.agentId, createdAt: now(), rotatedAt: now(), migrated: true });
      renameSync(legacy, `${legacy}.migrated`);
      return true;
    },
  };
}
