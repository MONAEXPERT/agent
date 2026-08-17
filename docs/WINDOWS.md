# Windows support

Mona Agent supports Windows through a native Windows Service Control Manager adapter and foreground CLI execution.

## Requirements

- Windows release within Microsoft's active security-support lifecycle.
- Node.js 20 or newer.
- Administrator elevation for `mona-agent daemon install`, update, and uninstall.
- A supported x64/ARM64 Node runtime.

End-of-life Windows releases are not supported for production use. The lifecycle status is intentionally conservative; an unknown lifecycle status must be reviewed before enterprise deployment.

## Native service

```powershell
mona-agent start
mona-agent daemon install   # elevated PowerShell
mona-agent daemon status
mona-agent daemon stop
mona-agent daemon uninstall
```

The service is named `MonaAgent`, runs in foreground mode under the Windows Service Control Manager, uses automatic delayed start, and configures restart recovery. Uninstall removes only the service registration; user data, policy, audit, and credentials remain.

## Security boundaries

- The service command contains only executable paths and startup arguments; API keys are not passed on the command line.
- Local policy remains authoritative over remote requests.
- Windows service operations use fixed service identity and reject non-Windows execution.
- Credential storage must use the secure Windows backend in enterprise deployments; plaintext file storage is degraded developer mode only.
- Shell execution is argv-based and allowlisted. Windows process-tree containment and signed MSI/MSIX packaging require validation on real Windows runners before enterprise certification.

## Support matrix policy

The project does not promise every historical Windows release. Each release must be tested against the selected supported Windows desktop and Server builds, current Node LTS versions, filesystem behavior, service lifecycle, credential backend, and installer artifacts. A release is not certified merely because it runs on `windows-latest` in CI.
