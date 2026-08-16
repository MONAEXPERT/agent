// File system tools — sandboxed to a workspace directory.
// Default workspace: $MONA_WORKSPACE or ~/.mona-agent/workspace

import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const WORKSPACE = process.env.MONA_WORKSPACE || path.join(homedir(), '.mona-agent', 'workspace');
const MAX_READ_BYTES  = 50_000;
const MAX_WRITE_BYTES = 1_000_000; // 1 MB

const root = () => path.resolve(WORKSPACE);

/** Resolve a user path inside the workspace. */
function safePath(p) {
  const r = root();
  const resolved = path.resolve(r, p);
  // Boundary-aware containment: /ws/foo is inside, /ws-evil is not.
  if (resolved !== r && !resolved.startsWith(r + path.sep)) {
    throw new Error(`Path traversal denied: ${p}`);
  }
  return resolved;
}

/**
 * Guard against symlink escapes: a symlink inside the workspace that points
 * outside must not let reads/writes leave the sandbox. Resolve the nearest
 * existing ancestor and verify it still lives under the real workspace root.
 */
async function guardSymlinks(target) {
  let cur = target;
  const stack = [];
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      const r = await fs.realpath(WORKSPACE);
      if (real !== r && !real.startsWith(r + path.sep)) {
        throw new Error(`Symlink escape denied: ${cur}`);
      }
      return;
    } catch (err) {
      if (err && err.code === 'ENOENT' && stack.length < 64) {
        stack.push(path.basename(cur));
        const parent = path.dirname(cur);
        if (parent === cur) throw err;
        cur = parent;
      } else {
        throw err;
      }
    }
  }
}

async function ensureWorkspace() {
  await fs.mkdir(WORKSPACE, { recursive: true });
}

export const files = {
  name: 'files',
  description: 'File system operations within the agent workspace (read, write, list, delete, stat)',
  args: {
    action: 'string — read | write | list | delete | stat',
    path:   'string — relative path within workspace',
    content:'string — file content (for write)',
  },

  async run(args) {
    await ensureWorkspace();
    const action = String(args.action || 'list').toLowerCase();

    switch (action) {
      case 'read': {
        if (!args.path) return { error: 'path required' };
        const fp = safePath(args.path);
        await guardSymlinks(fp);
        const content = await fs.readFile(fp, 'utf8');
        return { path: args.path, content: content.slice(0, MAX_READ_BYTES), truncated: content.length > MAX_READ_BYTES };
      }

      case 'write': {
        if (!args.path) return { error: 'path required' };
        if (args.content == null) return { error: 'content required' };
        const bytes = Buffer.byteLength(String(args.content));
        if (bytes > MAX_WRITE_BYTES) {
          return { error: `File too large (max ${MAX_WRITE_BYTES} bytes)` };
        }
        const fp = safePath(args.path);
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await guardSymlinks(fp);
        await fs.writeFile(fp, args.content, 'utf8');
        return { ok: true, path: args.path, bytes };
      }

      case 'list': {
        const dir = args.path ? safePath(args.path) : WORKSPACE;
        await guardSymlinks(dir);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
        }));
      }

      case 'delete': {
        if (!args.path) return { error: 'path required' };
        const fp = safePath(args.path);
        if (fp === root()) return { error: 'Refusing to delete workspace root' };
        await guardSymlinks(fp);
        await fs.rm(fp, { recursive: true, force: true });
        return { ok: true, path: args.path };
      }

      case 'stat': {
        if (!args.path) return { error: 'path required' };
        const fp = safePath(args.path);
        await guardSymlinks(fp);
        const st = await fs.stat(fp);
        return {
          path:     args.path,
          size:     st.size,
          isDir:    st.isDirectory(),
          modified: st.mtime.toISOString(),
          created:  st.birthtime.toISOString(),
        };
      }

      default:
        return { error: `Unknown file action: ${action}`, available: ['read', 'write', 'list', 'delete', 'stat'] };
    }
  },
};
