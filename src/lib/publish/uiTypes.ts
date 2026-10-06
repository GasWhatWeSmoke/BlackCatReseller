// Types shared by the Upload screens — the
// shapes of /api/publish/* responses, declared once so the tabs cannot drift.
import type { PackageDetails } from '../packageDetails.ts';

export interface MarketplaceInfo {
  id: string;
  name: string;
  implemented: boolean;
  configured: boolean;
  reason: string | null;
}

export interface RunInfo {
  id: number;
  status: string;
  note: string | null;
  totalJobs: number;
  startedAt: string;
  finishedAt: string | null;
  marketplaces: string[];
}

export interface Problem {
  jobId: number;
  sku: string;
  marketplace: string;
  status: string;
  error: string | null;
  validation: { field: string; message: string }[] | null;
  needsVerification?: boolean;
}

export interface StatusPayload {
  browserBusyWith?: string | null;
  run: RunInfo | null;
  byMarketplace?: Record<string, Record<string, number>>;
  current?: { sku: string; marketplace: string; attempt: number; startedAt?: string | null;
    phase?: { stage: string; photoCount?: number; updatedAt: string } | null } | null;
  jobs?: { jobId: number; itemId: number; sku: string; marketplace: string; status: string }[];
  problems?: Problem[];
  published?: { jobId: number; sku: string; marketplace: string; url: string | null }[];
  marketplaces: MarketplaceInfo[];
}

export interface EligibleItem {
  packageDetails?: PackageDetails;
  platformIssues: Record<string, { field: string; message: string }[]>;
  platformPrices?: Record<string, number>;
  id: number;
  sku: string;
  brand: string;
  itemType: string | null;
  size: string | null;
  price: number | null;
  photoCount: number;
  ready: boolean;
  issues: { field: string; message: string }[];
  publishedOn: string[];
  applicableOn?: string[];
}

export interface EligibilityQuery { page: number; pageSize: number; q: string; marketplaces: string[] }
export interface EligibilityPage {
  items: EligibleItem[];
  awaitingReview: ReviewPendingItem[];
  pagination: EligibilityQuery & { total: number; pages: number };
  counts: { approved: number; awaitingReview: number; withListings: number };
}

export const RUN_ACTIVE = new Set(["running", "paused"]);
export interface ReviewPendingItem { id: number; sku: string; brand: string | null; itemType: string | null; status: string; photoCount: number }
