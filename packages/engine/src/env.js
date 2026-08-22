// Environment resolver with legacy prefix fallback.
//
// The product renamed (mona-agent → RemoteAgent) and its environment
// variables moved from MONA_* to RA_*. Old variables keep working through
// this resolver — RA_* wins when both are set, MONA_* is the fallback,
// and a deprecation warning fires once per name per process.
//
// MONA_* support will be removed in v4.0.0 (announced in the changelog
// when this shim was added, per the project's deprecation policy).

const warned = new Set();

export function env(name, fallback = undefined) {
  const next = process.env[`RA_${name}`];
  if (next !== undefined) return next;
  const legacy = process.env[`MONA_${name}`];
  if (legacy !== undefined) {
    if (!warned.has(name)) {
      warned.add(name);
      process.emitWarning(
        `MONA_${name} is deprecated; use RA_${name}. ` +
        'Support will be removed in v4.0.0.',
        'DeprecationWarning'
      );
    }
    return legacy;
  }
  return fallback;
}

// Test-only hook: clears the once-per-process warning state so suites can
// assert the deprecation warning deterministically.
export function __resetEnvWarnings() {
  warned.clear();
}
