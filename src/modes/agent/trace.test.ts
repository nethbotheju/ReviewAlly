import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { agentTraceEnabled, createAgentTracer } from './trace';

describe('agent trace', () => {
  it('defaults on and accepts an explicit off flag', () => {
    expect(agentTraceEnabled(undefined)).toBe(true);
    expect(agentTraceEnabled('')).toBe(true);
    expect(agentTraceEnabled('false')).toBe(false);
    expect(agentTraceEnabled('0')).toBe(false);
    expect(agentTraceEnabled('on')).toBe(true);
    expect(() => agentTraceEnabled('sometimes')).toThrow('REVIEWALLY_AGENT_TRACE');
  });

  it('logs completed messages, tool names, arguments and results while masking keys', () => {
    const lines: string[] = [];
    const trace = createAgentTracer(true, ['test-provider-key'], (line) => lines.push(line));
    trace({
      type: 'tool_execution_start',
      toolCallId: 'one',
      toolName: 'read',
      args: {
        path: 'src/auth.ts',
        apiKey: 'other-key',
        api_key: 'nested-key',
        pattern: 'test-provider-key',
      },
    } as AgentSessionEvent);
    trace({
      type: 'tool_execution_end',
      toolCallId: 'one',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'file contents' }] },
      isError: false,
    } as AgentSessionEvent);
    trace({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Found an issue' }] },
    } as AgentSessionEvent);
    expect(lines.join('\n')).toContain('"name":"read"');
    expect(lines.join('\n')).toContain('src/auth.ts');
    expect(lines.join('\n')).toContain('file contents');
    expect(lines.join('\n')).toContain('Found an issue');
    expect(lines.join('\n')).not.toContain('test-provider-key');
    expect(lines.join('\n')).not.toContain('other-key');
    expect(lines.join('\n')).not.toContain('nested-key');
  });

  it('omits image data and provider reasoning from the visible transcript', () => {
    const lines: string[] = [];
    const trace = createAgentTracer(true, [], (line) => lines.push(line));
    trace({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'image', data: 'raw-image-bytes' },
          { type: 'thinking', thinking: 'private-reasoning' },
          { type: 'text', text: 'Visible answer' },
        ],
      },
    } as AgentSessionEvent);
    expect(lines.join('\n')).toContain('Visible answer');
    expect(lines.join('\n')).not.toContain('raw-image-bytes');
    expect(lines.join('\n')).not.toContain('private-reasoning');
  });

  it('does not log when disabled', () => {
    const log = vi.fn();
    createAgentTracer(false, [], log)({ type: 'agent_settled' });
    expect(log).not.toHaveBeenCalled();
  });
});
