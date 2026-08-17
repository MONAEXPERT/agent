import { platform, release, arch } from 'node:os';
import { VERSION } from './version.js';

// Product support is intentionally conservative: exact Windows lifecycle
// eligibility is maintained by release metadata, not guessed from a label.
export const WINDOWS_SUPPORT_POLICY = Object.freeze({
  requiresNodeMajor: 20,
  lifecycle: 'active-security-support-required',
  eolProduction: false,
});

export function runtimeSupport({ os = platform(), node = process.versions.node } = {}) {
  const nodeMajor = Number.parseInt(String(node).split('.')[0], 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < WINDOWS_SUPPORT_POLICY.requiresNodeMajor) {
    return { status: 'unsupported', reason: `Node.js ${WINDOWS_SUPPORT_POLICY.requiresNodeMajor}+ is required` };
  }
  if (os === 'win32') {
    return {
      status: 'unknown',
      reason: 'Windows release lifecycle must be verified against the published support matrix',
      lifecycle: WINDOWS_SUPPORT_POLICY.lifecycle,
    };
  }
  if (os === 'darwin' || os === 'linux') return { status: 'supported', reason: 'Supported runtime family' };
  return { status: 'unknown', reason: `Platform ${os} is not in the validated matrix` };
}

export function platformInfo() {
  return {
    os: platform(),
    release: release(),
    arch: arch(),
    version: VERSION,
    support: runtimeSupport(),
  };
}
