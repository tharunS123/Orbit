/**
 * Plan catalogue and limits. Names, prices and numbers are configuration — change them here.
 * Enforcement happens server-side (mutators + API) against the reconciled `entitlements` row.
 */

export const PLAN_IDS = ['free', 'plus', 'ultra'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export type Feature =
  | 'integrations_all'
  | 'talk'
  | 'meetings'
  | 'meeting_chat'
  | 'make_ai'
  | 'message_summaries'
  | 'nested_lists_unlimited';

export interface PlanLimits {
  /** Active (non-archived, non-deleted) lists a user owns across workspaces. */
  maxLists: number | null;
  maxCollaboratorsPerList: number;
  maxWorkspaceMembers: number;
  maxNestingDepth: number | null;
  maxFileBytes: number;
  storageBytes: number;
  /** Monthly quotas. `null` = fair use (still rate limited). */
  talkPerMonth: number | null;
  meetingsPerMonth: number | null;
  meetingMinutesPerMonth: number;
  aiTokensPerMonth: number;
  features: ReadonlySet<Feature>;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PLANS: Record<PlanId, { name: string; description: string; limits: PlanLimits }> = {
  free: {
    name: 'Free',
    description: 'Everything you need to organise your life and small projects.',
    limits: {
      maxLists: 20,
      maxCollaboratorsPerList: 5,
      maxWorkspaceMembers: 5,
      maxNestingDepth: 1,
      maxFileBytes: 10 * MB,
      storageBytes: 1 * GB,
      talkPerMonth: 10,
      meetingsPerMonth: 3,
      meetingMinutesPerMonth: 120,
      aiTokensPerMonth: 100_000,
      features: new Set<Feature>(['talk', 'meetings']),
    },
  },
  plus: {
    name: 'Plus',
    description: 'Unlimited lists, bigger teams, every integration and voice capture.',
    limits: {
      maxLists: null,
      maxCollaboratorsPerList: 50,
      maxWorkspaceMembers: 50,
      maxNestingDepth: null,
      maxFileBytes: 100 * MB,
      storageBytes: 25 * GB,
      talkPerMonth: null,
      meetingsPerMonth: 10,
      meetingMinutesPerMonth: 600,
      aiTokensPerMonth: 1_000_000,
      features: new Set<Feature>([
        'integrations_all',
        'talk',
        'meetings',
        'meeting_chat',
        'make_ai',
        'message_summaries',
        'nested_lists_unlimited',
      ]),
    },
  },
  ultra: {
    name: 'Ultra',
    description: 'AI meeting notes without the counting, meeting chat and the full AI toolkit.',
    limits: {
      maxLists: null,
      maxCollaboratorsPerList: 50,
      maxWorkspaceMembers: 100,
      maxNestingDepth: null,
      maxFileBytes: 100 * MB,
      storageBytes: 25 * GB,
      talkPerMonth: null,
      meetingsPerMonth: null,
      meetingMinutesPerMonth: 6000,
      aiTokensPerMonth: 10_000_000,
      features: new Set<Feature>([
        'integrations_all',
        'talk',
        'meetings',
        'meeting_chat',
        'make_ai',
        'message_summaries',
        'nested_lists_unlimited',
      ]),
    },
  },
};

/** Integrations available on Free. */
export const FREE_INTEGRATIONS = new Set(['google_calendar', 'email_forward']);

export const PRICES = {
  plus: { month: 8, year: 72 },
  ultra: { month: 16, year: 144 },
  currency: 'USD',
} as const;

export function planLimits(plan: PlanId): PlanLimits {
  return PLANS[plan].limits;
}

export function hasFeature(plan: PlanId, feature: Feature): boolean {
  return PLANS[plan].limits.features.has(feature);
}

export function canUseIntegration(plan: PlanId, provider: string): boolean {
  return hasFeature(plan, 'integrations_all') || FREE_INTEGRATIONS.has(provider);
}

/** The cheapest plan that unlocks a feature — used for upgrade prompts. */
export function planForFeature(feature: Feature): PlanId {
  return PLAN_IDS.find((p) => hasFeature(p, feature)) ?? 'ultra';
}

export function withinLimit(limit: number | null, current: number, adding = 1): boolean {
  return limit === null || current + adding <= limit;
}

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes % MB === 0 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
