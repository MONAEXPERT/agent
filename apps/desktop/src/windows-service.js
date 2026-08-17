import { spawnSync } from 'node:child_process';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WINDOWS_SERVICE = Object.freeze({ name: 'MonaAgent', displayName: 'Mona Agent', description: 'Policy-governed Mona AI execution agent' });
const ROOT = dirname(fileURLToPath(import.meta.url));

export function serviceScriptPath() { return join(ROOT, 'windows-service.ps1'); }
export function serviceBinaryPath({ nodePath = process.execPath, entrypoint = join(ROOT, '..', 'bin', 'mona-agent.js') } = {}) {
  if (!isAbsolute(nodePath) || !isAbsolute(entrypoint)) throw new Error('Windows service paths must be absolute');
  return `\"${nodePath}\" \"${entrypoint}\" start --force`;
}

function invoke(action, { runner = spawnSync, scriptPath = serviceScriptPath(), nodePath, entrypoint, cwd = process.cwd() } = {}) {
  if (process.platform !== 'win32') return { ok: false, supported: false, action, error: 'Windows Service Control Manager is available only on Windows' };
  const binaryPath = serviceBinaryPath({ nodePath, entrypoint });
  const result = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', scriptPath, '-Action', action, '-ServiceName', WINDOWS_SERVICE.name, '-DisplayName', WINDOWS_SERVICE.displayName, '-Description', WINDOWS_SERVICE.description, '-BinaryPath', binaryPath, '-WorkingDirectory', cwd], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, MONA_SERVICE: 'windows-scm' } });
  let data = null;
  try { data = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).at(-1)); } catch {}
  return { ok: result.status === 0 && data?.ok !== false, supported: true, action, code: result.status, state: data?.state, installed: data?.installed, running: data?.running, output: data, error: result.status === 0 ? null : 'Windows service operation failed' };
}
export function invokeWindowsService(action, options) { return invoke(action, options); }
export function installWindowsService(options) { return invoke('install', options); }
export const windowsServiceInstall = installWindowsService;
export function uninstallWindowsService(options) { return invoke('uninstall', options); }
export const windowsServiceUninstall = uninstallWindowsService;
export function startWindowsService(options) { return invoke('start', options); }
export function stopWindowsService(options) { return invoke('stop', options); }
export const windowsServiceStop = stopWindowsService;
export function statusWindowsService(options) { return invoke('status', options); }
export const windowsServiceStatus = statusWindowsService;
