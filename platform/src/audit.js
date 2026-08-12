/**
 * Audit Log — tamper-evident record of all platform activity.
 *
 * Every key action, LLM call, and agent event is logged.
 * Entries are append-only with sequential IDs and timestamps.
 */
import { getDB } from './db.js';

export class AuditLog {
  constructor(db) {
    this.db = db || getDB();
  }

  /**
   * Record an audit event.
   */
  record(type, data = {}, agentId = null) {
    const stmt = this.db.prepare(
      'INSERT INTO audit_log (type, data, agent_id) VALUES (?, ?, ?)'
    );
    stmt.run(type, JSON.stringify(data), agentId);
  }

  /**
   * Query audit entries with optional filters.
   */
  query({ type, agentId, limit = 100, offset = 0, from, to } = {}) {
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params = [];

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    if (agentId) {
      sql += ' AND agent_id = ?';
      params.push(agentId);
    }
    if (from) {
      sql += ' AND timestamp >= ?';
      params.push(from);
    }
    if (to) {
      sql += ' AND timestamp <= ?';
      params.push(to);
    }

    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      type: r.type,
      data: JSON.parse(r.data || '{}'),
      agentId: r.agent_id
    }));
  }

  /**
   * Count total entries.
   */
  count(type = null) {
    if (type) {
      return this.db.prepare('SELECT COUNT(*) as c FROM audit_log WHERE type = ?').get(type).c;
    }
    return this.db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c;
  }
}
