import { randomUUID } from 'node:crypto';
import type { AgentTask, AgentTaskInput } from '../shared/agent-task.ts';
import { runAgentTask, type AgentTaskRunner } from './agent-task-runner.ts';

interface TaskRequest extends AgentTaskInput {
  deviceId: string;
  actionId: string;
  title: string;
}

export class AgentTasks {
  private readonly tasks = new Map<string, AgentTask>();
  private readonly running = new Map<string, AbortController>();
  private readonly changed: (task: AgentTask) => void;
  private readonly runner: AgentTaskRunner;

  constructor(
    changed: (task: AgentTask) => void = () => {},
    runner: AgentTaskRunner = runAgentTask,
  ) {
    this.changed = changed;
    this.runner = runner;
  }

  list(): AgentTask[] {
    return [...this.tasks.values()].reverse().map(task => ({ ...task }));
  }

  start(request: TaskRequest): AgentTask {
    const active = this.list().find(task => task.deviceId === request.deviceId && task.actionId === request.actionId && task.status === 'running');
    if (active) return active;
    if (this.tasks.size >= 20) {
      const oldest = [...this.tasks.values()].find(task => !this.running.has(task.id));
      if (!oldest) throw new Error('Twenty AI tasks are already running. Stop a task before starting another.');
      this.tasks.delete(oldest.id);
    }
    const task: AgentTask = {
      id: randomUUID(), deviceId: request.deviceId, actionId: request.actionId,
      title: request.title, tool: request.tool, cwd: request.cwd,
      status: 'running', startedAt: Date.now(),
    };
    const controller = new AbortController();
    this.tasks.set(task.id, task);
    this.running.set(task.id, controller);
    this.changed({ ...task });
    void this.execute(task, request, controller);
    return { ...task };
  }

  cancel(id: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error('This AI task is no longer available.');
    if (task.status !== 'running') return;
    task.status = 'cancelled';
    task.finishedAt = Date.now();
    this.running.get(id)?.abort();
    this.changed({ ...task });
  }

  retain(actionIds: ReadonlySet<string>): void {
    for (const task of this.tasks.values()) if (!actionIds.has(task.actionId) && task.status === 'running') this.cancel(task.id);
  }

  disconnect(deviceId: string): void {
    for (const task of this.tasks.values()) if (task.deviceId === deviceId && task.status === 'running') this.cancel(task.id);
  }

  close(): void {
    for (const id of this.running.keys()) this.cancel(id);
  }

  private async execute(task: AgentTask, request: AgentTaskInput, controller: AbortController) {
    try {
      const output = await this.runner(request, controller.signal);
      if (controller.signal.aborted) return;
      task.status = 'completed';
      task.output = output.slice(-64 * 1024);
    } catch (error) {
      if (controller.signal.aborted) return;
      task.status = 'failed';
      task.error = (error instanceof Error ? error.message : String(error)).slice(-4000);
    } finally {
      this.running.delete(task.id);
      if (!controller.signal.aborted) {
        task.finishedAt = Date.now();
        this.changed({ ...task });
      }
    }
  }
}
