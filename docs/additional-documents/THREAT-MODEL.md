# Threat Model (STRIDE)

Scope: the mona-agent client (device daemon) and its communication with the
mona.expert cloud. The LLM providers (OpenAI, Anthropic, Google, DeepSeek,
OpenRouter) are third parties; their trust assumptions are stated explicitly.

## Assets

1. **Device control** — the ability to execute tools on the user's machine.
2. **Conversation content** — task text, reasoning, tool results, answers.
3. **Provider API keys** — stored encrypted on the cloud, used server-side.
4. **Device token** — the daemon's identity credential (on the device).
5. **Audit trail** — logs, traces, usage and cost data.

## Trust boundaries

- **Browser ↔ Cloud**: HTTPS, session auth + CSRF tokens.
- **Device ↔ Cloud**: HTTPS, Bearer device token; device initiates.
- **Cloud ↔ LLM provider**: HTTPS, per-user provider keys, decrypted only
  server-side at call time.

## STRIDE analysis

| Threat | Example | Mitigation |
|---|---|---|
| **Spoofing** | Attacker impersonates the device or the user | Device tokens are CSPRNG-generated and revocable; session auth with CSRF on writes; TLS certificate verification |
| **Tampering** | Intercept/modify task or results in transit | TLS 1.2+ everywhere; no plaintext fallback; integrity via Git-tagged releases |
| **Repudiation** | "The agent deleted the file, not me" | Complete audit trail per run: reasoning steps, tool calls with arguments, results, tokens, cost, latency |
| **Information disclosure** | Key leak from device, logs, or backup | Provider keys never sent to devices; AES-256-GCM at rest; secrets excluded from logs; per-user data scoping |
| **Denial of service** | Flood the cloud or the device | Per-user rate limits; plan-based limits; task expiry; step budgets; bounded tool output |
| **Elevation of privilege** | Prompt injection escalates a tool call | Tool allowlists (shell command allowlist, path-traversal rejection, URL scheme validation); the brain cannot grant itself new tools |

## Residual risks (accepted)

- **The cloud brain is an LLM**: a sufficiently creative prompt may produce an
  undesirable *allowed* action. Mitigated by allowlists, explicit background
  mode for long-running programs, and human-visible traces — but not
  eliminated. For high-stakes devices, restrict the tool set and keep a human
  in the loop.
- **Third-party providers**: conversation content is sent to the chosen LLM
  provider under the operator's own provider account terms.
- **Physical device access**: an attacker with OS-level access to the device
  can read the device token; revoke tokens immediately after device loss.

## Abuse scenarios reviewed

1. Malicious user sends a task that attempts shell command injection →
   blocked by the command allowlist.
2. Brain returns malformed JSON repeatedly → corrective nudges, then a safe
   final answer (no raw JSON leaks to the user).
3. Device goes offline mid-task → task expires with a closing message; no
   silent replay.
4. Stolen device token → server-side revocation kills the device connection.
