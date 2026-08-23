# Plugin & Release Supply Chain

Covers release/plugin attestation, signing, and the trusted-extension marketplace (backlog P1.4 and Goal 7).

## Release evidence (already enforced in `.github/workflows/release.yml`)
1. A tagged release cannot publish until the test suite, declaration tests, and dependency audit pass.
2. The release produces a deterministic source archive, SHA-256 checksums, an SBOM (`sbom.cyclonedx.json`), and a build-provenance attestation.
3. A consumer can verify the archive with a published `sha256sum` command.

## Plugin signing & permissions

Enforced at load time since the supply-chain round (`apps/desktop/src/tools/registry.js`):

1. **Discovery is confined** to the installation directory and explicit
   `MONA_TOOL_PATH` entries — never `process.cwd()`, because importing a
   package runs its top-level code.
2. **Pinned keys → signed manifests required.** When the owner pins plugin
   signing keys in `policy.json` (`plugins.publicKeys`), a package loads ONLY
   when its signed manifest (`monaAgent.manifest`) verifies under a pinned
   Ed25519 key. No manifest, no signature → no import; the module is never
   evaluated. Pinning keys is what makes loading itself verifiable — without
   pinned keys only the legacy shape check applies (tool policy still gates
   execution).
3. **Capabilities deny-by-default.** Before import, every capability declared
   in the manifest must be granted in `policy.json`
   (`plugins.capabilities`). The intersection wins — never the union.

```json
{
  "plugins": {
    "publicKeys": ["<SPKI PEM of the only key allowed to sign plugins>"],
    "capabilities": ["tools.load", "files.read"]
  }
}
```

Each plugin ships a manifest with: identity, version, capability/permission
list, compatibility range, and a content hash; the manifest is canonicalised,
hashed and Ed25519-signed (`packages/engine/src/plugin-manifest.js`).

**Verified by:** `apps/desktop/test/plugin-tool.test.mjs` (an unsigned package
must never be imported — its top-level code never runs) and
`packages/engine/test/plugin-manifest.test.mjs` (tampered manifest, foreign
key, missing capabilities).

## Provenance & certification
1. Each plugin carries provenance (who built it, from which revision, with which toolchain).
2. Certification tests exercise the plugin against its declared capabilities before marketplace listing.
3. Interoperability testing is aligned to enterprise standards (ISO 27001, GDPR) where applicable.

**Done when:** every installable extension has machine-verifiable provenance and a documented verification step.

## Marketplace (deferred scope)
The marketplace is a trusted index of signed, certified plugins. Broad third-party expansion remains deferred until durable execution and the three IT-operations runbooks demonstrate safe, repeatable outcomes (see `docs/IMPLEMENTATION-BACKLOG.md`).
