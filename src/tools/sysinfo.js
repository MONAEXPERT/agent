// System information tool — multi-OS device telemetry.
// Works on macOS, Linux, and Windows. Read-only, always safe.

import os from 'node:os';

const PLATFORM = os.platform();
const PLATFORM_LABEL = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

export const sysinfo = {
  name: 'sysinfo',
  description: `Get device system information (hostname, OS, CPU, memory, load, uptime) — running on ${PLATFORM_LABEL[PLATFORM] || PLATFORM}`,
  args: {},
  platform: PLATFORM,

  async run() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadavg = os.loadavg();

    // Platform-specific info
    const platformInfo = {};
    if (PLATFORM === 'darwin') {
      platformInfo.machine = os.machine?.() || os.arch();
      platformInfo.endianness = os.endianness?.() || 'LE';
    } else if (PLATFORM === 'linux') {
      const releaseInfo = os.release();
      platformInfo.kernel = releaseInfo;
    } else if (PLATFORM === 'win32') {
      platformInfo.version = os.version?.() || os.release();
    }

    return {
      host:       os.hostname(),
      platform:   PLATFORM,
      platformName: PLATFORM_LABEL[PLATFORM] || PLATFORM,
      arch:       os.arch(),
      release:    os.release(),
      cpus:       cpus.length,
      cpuModel:   cpus[0]?.model || 'unknown',
      cpuSpeed:   cpus[0]?.speed || 0,
      mem: {
        total:    totalMem,
        free:     freeMem,
        used:     totalMem - freeMem,
        percent:  Math.round((1 - freeMem / totalMem) * 100),
      },
      loadavg: loadavg.map(v => Math.round(v * 100) / 100),
      uptime:  Math.round(os.uptime()),
      network: Object.entries(os.networkInterfaces())
        .filter(([k]) => !k.startsWith('lo') && !k.startsWith('Loopback'))
        .flatMap(([iface, addrs]) =>
          (addrs || []).filter(a => a.family === 'IPv4' && !a.internal)
            .map(a => ({ iface, address: a.address }))
        )
        .slice(0, 8),
      ...platformInfo,
    };
  },
};
