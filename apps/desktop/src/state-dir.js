// State-directory migration (rebrand: ~/.mona-agent → ~/.remoteagent).
//
// Non-destructive by design: the legacy directory is MOVED to the new
// location and a symlink is left behind, so every hardcoded old path keeps
// resolving. The directory is never deleted — it holds credentials and the
// hash-chained audit log.
import { existsSync, lstatSync, renameSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LEGACY_STATE_DIR = '.mona-agent';
export const STATE_DIR = '.remoteagent';

/**
 * One-shot migration, idempotent. Returns true when it moved the directory.
 * Guards:
 *   - legacy missing            → nothing to do
 *   - legacy is already a link  → already migrated (or user-managed); leave it
 *   - target already exists     → never merge or overwrite; leave both
 * The symlink creation is best-effort: migration still succeeded without it.
 */
export function migrateStateDir({ home = homedir(), log = () => {} } = {}) {
  const legacy = join(home, LEGACY_STATE_DIR);
  const next = join(home, STATE_DIR);
  if (!existsSync(legacy)) return false;
  if (lstatSync(legacy).isSymbolicLink()) return false;
  if (existsSync(next)) return false;
  renameSync(legacy, next);
  try { symlinkSync(next, legacy, 'dir'); } catch { /* non-fatal */ }
  log(`Migrated state ${legacy} → ${next}`);
  return true;
}
