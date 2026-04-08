export interface GitContext {
  currentBranch: string;
  targetBranch: string;
  diff: string;
  commitLog: string;
  repoRoot: string;
}

export interface PrPayload {
  title: string;
  body: string;
}

export interface GenerateOptions {
  targetBranch: string;
  dryRun: boolean;
}

export type PrReviewAction = "comment" | "approve" | "request-changes";

export interface ReviewCommandOptions {
  pr: string;
  dryRun: boolean;
  inline: boolean;
  instruction?: string;
  mode?: PrReviewAction;
}

export interface PrReviewContext {
  pr: string;
  number: number;
  repoOwner: string;
  repoName: string;
  headSha: string;
  changedFilesPaths: string[];
  changedFileDiffs: PrChangedFileDiff[];
  title: string;
  body: string;
  authorLogin: string;
  baseRefName: string;
  headRefName: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  url: string;
  diff: string;
}

export interface PrChangedFileDiff {
  path: string;
  patch: string;
}

export interface PrReviewPayload {
  summary: string;
  suggestions: string[];
  securityConcerns: string[];
  recommendedAction: PrReviewAction;
  reviewComment: string;
  inlineComments: PrInlineComment[];
}

export interface PrInlineComment {
  path: string;
  line: number;
  title: string;
  detail: string;
}

export interface ReleaseCreateOptions {
  base?: string;
  from?: string;
  tag?: string;
  yes: boolean;
  dryRun: boolean;
  lang?: string;
}

export type AiBackend =
  | "anthropic-sdk"
  | "openai-sdk"
  | "claude-cli"
  | "cursor-cli"
  | "opencode-cli"
  | "codex-cli"
  | "llm-cli";

export interface AiBackendInfo {
  type: AiBackend;
  label: string;
}

export type ReleaseLanguage = "en" | "pt";

export interface ReleaseCommit {
  hash: string;
  subject: string;
  body: string;
  type: string;
  scope?: string;
  description: string;
  breaking: boolean;
}

export interface VersionSuggestion {
  level: "major" | "minor" | "patch";
  suggestedTag: string;
  patchTag: string;
  minorTag: string;
  majorTag: string;
  reason: string;
}

export interface ReleaseContext {
  repoRoot: string;
  repoSlug: string;
  baseBranch: string;
  sourceBranch: string;
  lastTag: string;
  commits: ReleaseCommit[];
  suggestion: VersionSuggestion;
  language: ReleaseLanguage;
  languageConfidence: number;
  languageReason: string;
}
