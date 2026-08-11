// The local agent loop. Reasoning is remote; execution + telemetry are local.
import { think } from './cloud.js';
import { TelemetryStream } from './telemetry.js';

export class Agent {
  constructor(creds) {
    this.creds = creds;
    this.telemetry = new TelemetryStream(creds.apiKey, creds.agentId).connect();
    this.messages = [];
  }

  async run(task, onToken) {
    this.telemetry.step('task.start', { task });
    this.messages.push({ role: 'user', content: task });

    let answer = '';
    await think({
      apiKey: this.creds.apiKey,
      messages: this.messages,
      tools: [], // local tool schema can be advertised here later
      onChunk: (delta) => {
        answer += delta;
        onToken?.(delta);
        this.telemetry.send('agent.token', { delta });
      },
    });

    this.messages.push({ role: 'assistant', content: answer });
    this.telemetry.step('task.done', { chars: answer.length });
    return answer;
  }

  close() { this.telemetry.close(); }
}
