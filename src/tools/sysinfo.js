// System information tool — safe, read-only device telemetry.

import os from 'node:os';

export const sysinfo = {
  name: 'sysinfo',
  description: 'Get device system information (hostname, OS, CPU, memory, load, uptime)',
  args: {},

  async run() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    return {
      host:     os.hostname(),
      platform: os.platform(),
      arch:     os.arch(),
      release:  os.release(),
      cpus:     cpus.length,
      cpuModel: cpus[0]?.model || 'unknown',
      mem: {
        total:   totalMem,
        free:    freeMem,
        used:    totalMem - freeMem,
        percent: Math.round((1 - freeMem / totalMem) * 100),
      },
      loadavg: os.loadavg().map(v => Math.round(v * 100) / 100),
      uptime:  Math.round(os.uptime()),
      network: Object.entries(os.networkInterfaces())
        .filter(([k]) => !k.startsWith('lo'))
        .flatMap(([iface, addrs]) =>
          addrs.filter(a => a.family === 'IPv4' && !a.internal)
            .map(a => ({ iface, address: a.address }))
        )
        .slice(0, 4),
    };
  },
};
