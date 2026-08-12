/**
 * API Key Vault — secure storage for LLM provider keys.
 *
 * Keys are encrypted at rest (AES-256-GCM) using a platform secret.
 * The agent never sees keys; the platform proxies all LLM calls.
 */
import crypto from 'node:crypto';
import { getDB } from './db.js';

const ALGORITHM = 'aes-256-gcm';
const SECRET = process.env.VAULT_SECRET || crypto.randomBytes(32).toString('hex');

function deriveKey() {
  return crypto.scryptSync(SECRET, 'agent.mona.expert', 32);
}

function encrypt(plaintext) {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString('hex'),
    data: encrypted.toString('hex'),
    tag: tag.toString('hex')
  });
}

function decrypt(encryptedJSON) {
  try {
    const { iv, data, tag } = JSON.parse(encryptedJSON);
    const key = deriveKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}

export class Vault {
  constructor(db) {
    this.db = db || getDB();
  }

  /**
   * Add an API key to the vault.
   */
  add(provider, label, key) {
    const id = `key_${crypto.randomUUID().slice(0, 12)}`;
    const encrypted = encrypt(key);
    this.db.prepare(
      'INSERT INTO api_keys (id, provider, label, key_encrypted) VALUES (?, ?, ?, ?)'
    ).run(id, provider, label, encrypted);
    return id;
  }

  /**
   * Get the decrypted key for a provider.
   * Returns the first matching key if keyId is not specified.
   */
  get(keyId) {
    const row = keyId
      ? this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId)
      : this.db.prepare('SELECT * FROM api_keys ORDER BY created DESC LIMIT 1').get();

    if (!row) return null;

    const key = decrypt(row.key_encrypted);
    if (!key) return null;

    // Update last_used
    this.db.prepare('UPDATE api_keys SET last_used = datetime("now") WHERE id = ?').run(row.id);

    return { id: row.id, provider: row.provider, label: row.label, key };
  }

  /**
   * Get a key specifically for a provider.
   */
  getForProvider(provider) {
    const row = this.db.prepare(
      'SELECT * FROM api_keys WHERE provider = ? ORDER BY created DESC LIMIT 1'
    ).get(provider);
    if (!row) return null;
    const key = decrypt(row.key_encrypted);
    if (!key) return null;
    this.db.prepare('UPDATE api_keys SET last_used = datetime("now") WHERE id = ?').run(row.id);
    return { id: row.id, provider: row.provider, label: row.label, key };
  }

  /**
   * List all keys (without the actual key values).
   */
  list() {
    const rows = this.db.prepare('SELECT id, provider, label, key_encrypted, created, last_used FROM api_keys ORDER BY created DESC').all();
    return rows.map(r => ({
      id: r.id,
      provider: r.provider,
      label: r.label,
      masked: '••••' + (r.label || '').slice(-4),
      created: r.created,
      lastUsed: r.last_used
    }));
  }

  /**
   * Remove a key from the vault.
   */
  remove(id) {
    const result = this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * Count stored keys.
   */
  count() {
    return this.db.prepare('SELECT COUNT(*) as c FROM api_keys').get().c;
  }
}
