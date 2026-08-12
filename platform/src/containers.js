/**
 * Container Manager — Docker-based agent isolation.
 *
 * Creates, starts, stops, and removes agent containers.
 * Each agent runs in its own Docker container with the agent runtime.
 */
import crypto from 'node:crypto';
import { getDB } from './db.js';

// Try to load Dockerode; gracefully degrade if Docker isn't available
let Docker = null;
let dockerAvailable = false;
try {
  const dockerModule = await import('dockerode');
  Docker = dockerModule.default;
  const docker = new Docker();
  await docker.ping();
  dockerAvailable = true;
  console.log('  Docker: connected');
} catch (err) {
  console.log(`  Docker: unavailable (${err.message?.split('\n')[0] || 'not running'}) — container management disabled`);
  console.log('  Starting in dev mode — agents will run as local processes');
}

const AGENT_IMAGE = process.env.AGENT_IMAGE || 'agent.mona.expert/agent:latest';
const AGENT_PORT_START = parseInt(process.env.AGENT_PORT_START) || 4500;

export class ContainerManager {
  constructor(db) {
    this.db = db || getDB();
    this.docker = dockerAvailable ? new Docker() : null;
    this.nextPort = AGENT_PORT_START;
  }

  /**
   * List all agents.
   */
  async list() {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY created DESC').all();

    if (this.docker) {
      // Enrich with live Docker status
      for (const row of rows) {
        if (row.container_id) {
          try {
            const container = this.docker.getContainer(row.container_id);
            const info = await container.inspect();
            row.status = info.State?.Running ? 'running' : info.State?.Status || 'unknown';
          } catch {
            row.status = 'removed';
          }
        }
      }
    }

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      model: r.model,
      systemPrompt: r.system_prompt,
      tools: JSON.parse(r.tools || '[]'),
      status: r.status,
      created: r.created,
      lastActive: r.last_active
    }));
  }

  /**
   * Create a new agent (builds config, creates container).
   */
  async create({ name, model, systemPrompt, tools }) {
    const id = `agent_${crypto.randomUUID().slice(0, 8)}`;
    const port = this.nextPort++;

    this.db.prepare(
      `INSERT INTO agents (id, name, model, system_prompt, tools, status, port)
       VALUES (?, ?, ?, ?, ?, 'creating', ?)`
    ).run(id, name, model, systemPrompt || '', JSON.stringify(tools || []), port);

    if (this.docker) {
      try {
        // Pull image if needed
        await this.docker.pull(AGENT_IMAGE).catch(() => {
          // Image might not exist yet; try building
          console.log(`  Image ${AGENT_IMAGE} not found, attempting to use locally...`);
        });

        const container = await this.docker.createContainer({
          name: `mona-agent-${id}`,
          Image: AGENT_IMAGE,
          Env: [
            `AGENT_ID=${id}`,
            `AGENT_NAME=${name}`,
            `AGENT_MODEL=${model}`,
            `PLATFORM_URL=http://host.docker.internal:${process.env.PORT || 4300}/ws`,
            `AGENT_TOOLS=${JSON.stringify(tools)}`,
            `AGENT_SYSTEM_PROMPT=${systemPrompt || ''}`
          ],
          ExposedPorts: { [`${port}/tcp`]: {} },
          HostConfig: {
            PortBindings: { [`${port}/tcp`]: [{ HostPort: `${port}` }] },
            Memory: 512 * 1024 * 1024, // 512MB
            NanoCpus: 1_000_000_000,   // 1 CPU
            ReadonlyRootfs: false,
            SecurityOpt: ['no-new-privileges:true'],
            CapDrop: ['ALL'],
            CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETUID']
          }
        });

        this.db.prepare('UPDATE agents SET container_id = ?, status = ? WHERE id = ?')
          .run(container.id, 'stopped', id);

        console.log(`  Agent container created: ${id} (${name})`);
      } catch (err) {
        this.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('error', id);
        throw new Error(`Docker create failed: ${err.message}`);
      }
    } else {
      // Dev mode: no Docker, just record
      this.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('stopped', id);
      console.log(`  Agent created (dev mode): ${id} (${name})`);
    }

    return { id, name, model, status: 'stopped', tools, port };
  }

  /**
   * Start an agent container.
   */
  async start(agentId) {
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    if (this.docker && agent.container_id) {
      const container = this.docker.getContainer(agent.container_id);
      await container.start();
    }

    this.db.prepare('UPDATE agents SET status = ?, last_active = datetime("now") WHERE id = ?')
      .run('running', agentId);
    return { ok: true, status: 'running' };
  }

  /**
   * Stop an agent container.
   */
  async stop(agentId) {
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    if (this.docker && agent.container_id) {
      try {
        const container = this.docker.getContainer(agent.container_id);
        await container.stop();
      } catch { /* container already stopped */ }
    }

    this.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('stopped', agentId);
    return { ok: true, status: 'stopped' };
  }

  /**
   * Remove an agent and its container.
   */
  async remove(agentId) {
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    if (this.docker && agent.container_id) {
      try {
        const container = this.docker.getContainer(agent.container_id);
        await container.stop().catch(() => {});
        await container.remove({ force: true });
      } catch { /* already removed */ }
    }

    this.db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
    return { ok: true };
  }

  /**
   * Get container logs.
   */
  async logs(agentId, tail = 200) {
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
    if (!agent || !agent.container_id) return '';

    if (this.docker) {
      try {
        const container = this.docker.getContainer(agent.container_id);
        const stream = await container.logs({
          stdout: true, stderr: true, tail, timestamps: true
        });
        return stream.toString('utf8');
      } catch {
        return '';
      }
    }

    return '';
  }

  /**
   * Docker system info.
   */
  async systemInfo() {
    if (!this.docker) return { available: false };

    try {
      const info = await this.docker.info();
      return {
        available: true,
        containers: info.Containers,
        running: info.ContainersRunning,
        memory: info.MemTotal,
        cpus: info.NCPU,
        os: info.OperatingSystem
      };
    } catch {
      return { available: false };
    }
  }
}
