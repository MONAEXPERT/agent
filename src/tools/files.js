// File system tools — sandboxed to a workspace directory.
// Default workspace: $MONA_WORKSPACE or ~/.mona-agent/workspace

import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const WORKSPACE = process.env.MONA_WORKSPACE || path.join(homedir(), '.mona-agent', 'workspace');

function safePath(p) {
  const resolved = path.resolve(WORKSPACE, p);
  if (!resolved.startsWith(path.resolve(WORKSPACE))) {
    throw new Error(`Path traversal denied: ${p}`);
  }
  return resolved;
}

async function ensureWorkspace() {
  await fs.mkdir(WORKSPACE, { recursive: true });
}

export const files = {
  name: 'files',
  description: 'File system operations within the agent workspace (read, write, list, delete)',
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
        const content = await fs.readFile(safePath(args.path), 'utf8');
        return { path: args.path, content: content.slice(0, 50_000), truncated: content.length > 50_000 };
      }

      case 'write': {
        if (!args.path) return { error: 'path required' };
        if (args.content == null) return { error: 'content required' };
        const fp = safePath(args.path);
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await fs.writeFile(fp, args.content, 'utf8');
        return { ok: true, path: args.path, bytes: Buffer.byteLength(args.content) };
      }

      case 'list': {
        const dir = args.path ? safePath(args.path) : WORKSPACE;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
        }));
      }

      case 'delete': {
        if (!args.path) return { error: 'path required' };
        await fs.rm(safePath(args.path), { recursive: true, force: true });
        return { ok: true, path: args.path };
      }

      case 'stat': {
        if (!args.path) return { error: 'path required' };
        const st = await fs.stat(safePath(args.path));
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
