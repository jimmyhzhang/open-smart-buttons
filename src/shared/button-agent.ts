/** claude = Claude Code CLI, codex = Codex CLI, api = Anthropic API key. */
export type ButtonAgentProvider = 'claude' | 'codex' | 'api';
/** Automatic uses the first ready engine in AI_ENGINE_ORDER. */
export type AiPreference = 'auto' | ButtonAgentProvider;
export const AI_ENGINE_ORDER = ['claude', 'codex', 'api'] as const satisfies readonly ButtonAgentProvider[];
export const aiEngineName: Record<ButtonAgentProvider, string> = { claude: 'Claude Code', codex: 'Codex', api: 'Anthropic API key' };
export interface AiEngine {
  id: ButtonAgentProvider;
  name: string;
  /** Who receives the request. */
  vendor: string;
  status: 'ready' | 'signed-out' | 'missing' | 'not-configured';
  detail: string;
  executable: string | null;
}
export interface AiStatus {
  preference: AiPreference;
  engines: AiEngine[];
  active: ButtonAgentProvider | null;
  /** Why no engine is ready, in words a user can act on. */
  message?: string;
}
export interface ButtonTarget { profileId: string; pageId: string; kind: 'key' | 'dial'; index: number }
export type ButtonJobStatus = 'creating' | 'validating' | 'repairing' | 'ready' | 'failed' | 'cancelled' | 'interrupted' | 'undone' | 'needs-input';
export interface ButtonRun { status: 'running' | 'completed' | 'failed' | 'blocked'; at: number; message: string; output?: string }
export interface ButtonJob { id: string; target: ButtonTarget; instruction: string; provider: ButtonAgentProvider; status: ButtonJobStatus; startedAt: number; updatedAt: number; summary?: string; error?: string; title?: string; icon?: string; checks?: string[]; lastRun?: ButtonRun; applied?: boolean }
export interface ButtonProposal { title: string; icon: string; color: string; type: string; settingsJson: string; statesJson: string; script: string; summary: string }
const PROPOSAL_FIELDS = ['title','icon','color','type','settingsJson','statesJson','script','summary'] as const;
export const activeButtonJob = (s: ButtonJobStatus) => ['creating', 'validating', 'repairing'].includes(s);
export const BUTTON_SCHEMA = { type: 'object', additionalProperties: false, properties: Object.fromEntries(PROPOSAL_FIELDS.map(k => [k,{type:'string'}])), required: [...PROPOSAL_FIELDS] };
