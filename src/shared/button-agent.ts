export type ButtonAgentProvider = 'codex' | 'claude';
export interface ButtonTarget { profileId: string; pageId: string; kind: 'key' | 'dial'; index: number }
export type ButtonJobStatus = 'creating' | 'validating' | 'repairing' | 'ready' | 'failed' | 'cancelled' | 'interrupted' | 'undone' | 'needs-input';
export interface ButtonRun { status: 'running' | 'completed' | 'failed' | 'blocked'; at: number; message: string; output?: string }
export interface ButtonJob { id: string; target: ButtonTarget; instruction: string; provider: ButtonAgentProvider; status: ButtonJobStatus; startedAt: number; updatedAt: number; summary?: string; error?: string; title?: string; icon?: string; checks?: string[]; lastRun?: ButtonRun; applied?: boolean }
export interface ButtonProposal { title: string; icon: string; color: string; type: string; settingsJson: string; statesJson: string; script: string; summary: string }
const PROPOSAL_FIELDS = ['title','icon','color','type','settingsJson','statesJson','script','summary'] as const;
export const activeButtonJob = (s: ButtonJobStatus) => ['creating', 'validating', 'repairing'].includes(s);
export const BUTTON_SCHEMA = { type: 'object', additionalProperties: false, properties: Object.fromEntries(PROPOSAL_FIELDS.map(k => [k,{type:'string'}])), required: [...PROPOSAL_FIELDS] };
