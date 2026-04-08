import { ReleaseError } from "../errors/index.js";
import {
  fetchOriginTags,
  getCurrentBranch,
  getLastSemverTag,
  getReleaseCommitsRaw,
  getRemoteDefaultBranch,
  getRepoRoot,
  getRepoSlugFromOrigin,
  hasRemoteBranch,
  remoteTagExists,
} from "./git.js";
import type {
  ReleaseCommit,
  ReleaseContext,
  ReleaseCreateOptions,
  ReleaseLanguage,
  VersionSuggestion,
} from "../types/index.js";

const COMMIT_HEADER_REGEX = /^(?<type>[a-z]+)(\((?<scope>[^)]+)\))?(?<breaking>!)?:\s*(?<description>.+)$/i;

const EN_STOPWORDS = new Set([
  "add",
  "added",
  "update",
  "updated",
  "remove",
  "removed",
  "fix",
  "fixed",
  "for",
  "with",
  "from",
  "into",
  "and",
  "the",
  "a",
  "an",
  "to",
  "on",
  "in",
  "of",
]);

const PT_STOPWORDS = new Set([
  "adiciona",
  "adicionar",
  "adicionado",
  "atualiza",
  "atualizado",
  "remove",
  "remover",
  "corrige",
  "correcao",
  "para",
  "com",
  "de",
  "da",
  "do",
  "e",
  "no",
  "na",
  "em",
  "uma",
  "um",
]);

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

interface LanguageDetectionResult {
  language: ReleaseLanguage;
  confidence: number;
  reason: string;
}

const parseSemverTag = (tag: string): ParsedVersion => {
  const match = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new ReleaseError(`Invalid semver tag format: ${tag}. Expected vX.Y.Z.`);
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
};

const toTag = (version: ParsedVersion): string =>
  `v${version.major}.${version.minor}.${version.patch}`;

const bumpVersion = (
  version: ParsedVersion,
  level: VersionSuggestion["level"]
): ParsedVersion => {
  if (level === "major") {
    return { major: version.major + 1, minor: 0, patch: 0 };
  }

  if (level === "minor") {
    return { major: version.major, minor: version.minor + 1, patch: 0 };
  }

  return { major: version.major, minor: version.minor, patch: version.patch + 1 };
};

const parseCommitRow = (row: string): ReleaseCommit | null => {
  const [hash, subject, body = ""] = row.split("\u001f");
  const cleanHash = hash?.trim();
  const cleanSubject = subject?.trim();

  if (!cleanHash || !cleanSubject) {
    return null;
  }

  const headerMatch = cleanSubject.match(COMMIT_HEADER_REGEX);
  const type = (headerMatch?.groups?.["type"] ?? "misc").toLowerCase();
  const scope = headerMatch?.groups?.["scope"]?.trim();
  const description = (headerMatch?.groups?.["description"] ?? cleanSubject).trim();
  const bodyLower = body.toLowerCase();
  const hasBreakingFooter = bodyLower.includes("breaking change:");
  const hasBreakingBang = Boolean(headerMatch?.groups?.["breaking"]);

  return {
    hash: cleanHash,
    subject: cleanSubject,
    body,
    type,
    scope,
    description,
    breaking: hasBreakingBang || hasBreakingFooter,
  };
};

const parseCommits = (raw: string): ReleaseCommit[] =>
  raw
    .split("\u001e")
    .map((row) => row.trim())
    .filter(Boolean)
    .map(parseCommitRow)
    .filter((commit): commit is ReleaseCommit => commit !== null);

const detectLanguage = (commits: ReleaseCommit[], explicitLang?: string): LanguageDetectionResult => {
  if (explicitLang) {
    const normalized = explicitLang.toLowerCase();
    const language: ReleaseLanguage = normalized.startsWith("pt") ? "pt" : "en";
    return { language, confidence: 1, reason: `forced by --lang=${explicitLang}` };
  }

  const corpus = commits
    .map((commit) => `${commit.description} ${commit.body}`.toLowerCase())
    .join(" ");

  const words = corpus.match(/[a-zA-Z\u00C0-\u00FF]+/g) ?? [];
  if (words.length === 0) {
    return { language: "en", confidence: 0, reason: "no words detected, fallback to English" };
  }

  let enScore = 0;
  let ptScore = 0;

  for (const word of words) {
    if (EN_STOPWORDS.has(word)) enScore += 1;
    if (PT_STOPWORDS.has(word)) ptScore += 1;
    if (/[\u00E0-\u00FC]/.test(word)) {
      ptScore += 1;
    }
  }

  const total = enScore + ptScore;
  if (total === 0) {
    return { language: "en", confidence: 0, reason: "no stopword matches, fallback to English" };
  }

  const bestScore = Math.max(enScore, ptScore);
  const confidence = bestScore / total;
  const language: ReleaseLanguage = ptScore > enScore ? "pt" : "en";

  if (confidence < 0.55) {
    return {
      language: "en",
      confidence,
      reason: "mixed language detected, fallback to English",
    };
  }

  return { language, confidence, reason: `detected from commit text (en=${enScore}, pt=${ptScore})` };
};

const buildSuggestion = (
  commits: ReleaseCommit[],
  lastTag: string,
  language: ReleaseLanguage
): VersionSuggestion => {
  const baseVersion = parseSemverTag(lastTag);
  const hasBreaking = commits.some((commit) => commit.breaking);
  const hasFeature = commits.some((commit) => commit.type === "feat");

  const level: VersionSuggestion["level"] = hasBreaking
    ? "major"
    : hasFeature
      ? "minor"
      : "patch";

  const reasonMap = {
    en: {
      major: "breaking changes found",
      minor: "feature commits found",
      patch: "no features/breaking changes, using patch",
    },
    pt: {
      major: "mudancas breaking encontradas",
      minor: "commits de feature encontrados",
      patch: "sem features/breaking, usando patch",
    },
  } as const;

  return {
    level,
    suggestedTag: toTag(bumpVersion(baseVersion, level)),
    patchTag: toTag(bumpVersion(baseVersion, "patch")),
    minorTag: toTag(bumpVersion(baseVersion, "minor")),
    majorTag: toTag(bumpVersion(baseVersion, "major")),
    reason: reasonMap[language][level],
  };
};

const isReleasableType = (type: string): boolean =>
  ["feat", "fix", "perf", "docs", "chore", "refactor", "test", "build", "ci", "deps", "misc"].includes(
    type
  );

const getDefaultBaseBranch = async (): Promise<string> => {
  try {
    return await getRemoteDefaultBranch();
  } catch {
    return "main";
  }
};

export const prepareReleaseContext = async (
  options: ReleaseCreateOptions
): Promise<ReleaseContext> => {
  await fetchOriginTags();

  const repoRoot = await getRepoRoot();
  const repoSlug = await getRepoSlugFromOrigin();
  const baseBranch = options.base ?? (await getDefaultBaseBranch());
  const sourceBranch = (await hasRemoteBranch("dev")) ? "dev" : await getCurrentBranch();
  const fromRef = options.from ?? (await getLastSemverTag(baseBranch));
  const lastTag = options.from ? fromRef : await getLastSemverTag(baseBranch);

  const rawCommits = await getReleaseCommitsRaw(fromRef, baseBranch);
  const commits = parseCommits(rawCommits).filter((commit) => isReleasableType(commit.type));

  if (commits.length === 0) {
    throw new ReleaseError(`No releasable changes detected in ${fromRef}..origin/${baseBranch}.`);
  }

  const languageDetection = detectLanguage(commits, options.lang);
  const suggestion = buildSuggestion(commits, lastTag, languageDetection.language);

  return {
    repoRoot,
    repoSlug,
    baseBranch,
    sourceBranch,
    lastTag,
    commits,
    suggestion,
    language: languageDetection.language,
    languageConfidence: languageDetection.confidence,
    languageReason: languageDetection.reason,
  };
};

const formatCommit = (commit: ReleaseCommit): string => {
  if (commit.type === "misc") {
    return commit.description;
  }
  if (commit.scope) {
    return `${commit.type}(${commit.scope}): ${commit.description}`;
  }
  return `${commit.type}: ${commit.description}`;
};

const sectionTitles = {
  en: {
    features: "Features",
    fixes: "Bug Fixes",
    docs: "Documentation",
    chores: "Miscellaneous Chores",
    fullChangelog: "Full Changelog",
  },
  pt: {
    features: "Funcionalidades",
    fixes: "Correcao de Bugs",
    docs: "Documentacao",
    chores: "Outras Tarefas",
    fullChangelog: "Changelog Completo",
  },
} as const;

const pushIfNotEmpty = (parts: string[], title: string, rows: string[]): void => {
  if (rows.length === 0) return;
  parts.push(`### ${title}`);
  parts.push(...rows.map((row) => `- ${row}`));
  parts.push("");
};

export const buildReleaseNotes = (context: ReleaseContext, tag: string): string => {
  const now = new Date().toISOString().slice(0, 10);
  const labels = sectionTitles[context.language];

  const features: string[] = [];
  const fixes: string[] = [];
  const docs: string[] = [];
  const chores: string[] = [];

  for (const commit of context.commits) {
    const line = formatCommit(commit);

    if (commit.type === "feat") {
      features.push(line);
      continue;
    }
    if (commit.type === "fix" || commit.type === "perf") {
      fixes.push(line);
      continue;
    }
    if (commit.type === "docs") {
      docs.push(line);
      continue;
    }
    chores.push(line);
  }

  const parts: string[] = [`## ${tag} (${now})`, ""];

  pushIfNotEmpty(parts, labels.features, features);
  pushIfNotEmpty(parts, labels.fixes, fixes);
  pushIfNotEmpty(parts, labels.docs, docs);
  pushIfNotEmpty(parts, labels.chores, chores);

  parts.push(
    `**${labels.fullChangelog}**: https://github.com/${context.repoSlug}/compare/${context.lastTag}...${tag}`
  );

  return parts.join("\n").trim();
};

export const validateTag = (tag: string): void => {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new ReleaseError(`Invalid tag format: ${tag}. Expected vX.Y.Z.`);
  }
};

export const ensureTagDoesNotExist = async (tag: string): Promise<void> => {
  if (await remoteTagExists(tag)) {
    throw new ReleaseError(`Tag ${tag} already exists on origin.`);
  }
};

export const countCommitTypes = (commits: ReleaseCommit[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const commit of commits) {
    counts[commit.type] = (counts[commit.type] ?? 0) + 1;
  }
  return counts;
};
