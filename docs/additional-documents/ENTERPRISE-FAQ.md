# Enterprise FAQ

Answers to the questions procurement, security and compliance teams ask.

**Where do the models run?**
Reasoning runs in the cloud (agent.mona.expert) through your own LLM provider
API keys (OpenAI, Anthropic, Google, DeepSeek or OpenRouter). Your devices
never run models and never hold provider keys.

**Does the device open any ports?**
No. The daemon makes outbound HTTPS connections only and polls for work.

**What data leaves my device?**
The task text, the tool results relevant to the task, and lightweight
performance metrics (CPU, memory, disk, uptime). No keystrokes, no screen
capture, no browsing history. Provider keys never leave the cloud.

**Where is my data stored?**
Conversations, run traces and usage metrics are stored server-side, scoped
per user account. Device telemetry keeps the latest sample plus a short
rolling history.

**Can we delete everything?**
Yes. Per-agent deletion, per-user factory reset, device telemetry forget and
token revocation are one-click operations in the dashboard. Data is also
exportable (JSONL) for audits or model training.

**What compliance frameworks do you support?**
See the documents in this folder: EU CRA readiness, ISO/IEC 27001 control
mapping, IEC 62443 alignment, GDPR data-flow documentation and a SOC 2
readiness audit trail. SECURITY.md defines vulnerability handling.

**What happens if a device is stolen?**
Revoke its token in the dashboard; the device loses access immediately.
Provider keys are unaffected (they were never on the device).

**What happens if the cloud is unreachable?**
The daemon retries with backoff and continues polling; tasks queue and are
delivered when connectivity returns, or expire with a closing message after
10 minutes of a dead device.

**Can the agent do something destructive?**
Tools are allowlisted: shell commands run against an explicit allowlist, file
access is confined to a workspace with path-traversal protection, and web
access validates URL schemes. Every action is traced with full arguments and
results. For high-stakes devices, disable shell entirely.

**How much does it cost?**
The client is open source (MIT). LLM usage is billed by your own provider
keys; the dashboard shows exact per-run token counts and cost, and an auto
mode balances reasoning depth against cost per task.

**Is there an on-premise option?**
The client is fully self-contained and connects to the cloud endpoint;
contact the project for deployment and integration options.
