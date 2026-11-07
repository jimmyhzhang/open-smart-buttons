/** A saved-prompt execution, separate from the agent that designs buttons. */
export interface AgentTask {
  id: string;
  deviceId: string;
  actionId: string;
  title: string;
  tool: 'claude' | 'codex';
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  output?: string;
  error?: string;
}

export interface AgentTaskInput {
  tool: AgentTask['tool'];
  cwd: string;
  prompt: string;
}
