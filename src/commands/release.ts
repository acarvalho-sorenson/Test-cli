import * as p from "@clack/prompts";
import { createRelease, verifyGhAuth } from "../services/github.js";
import {
  buildReleaseNotes,
  countCommitTypes,
  ensureTagDoesNotExist,
  prepareReleaseContext,
  validateTag,
} from "../services/release.js";
import type { ReleaseContext, ReleaseCreateOptions, ReleaseLanguage } from "../types/index.js";

const MESSAGES = {
  en: {
    intro: "ghprai — preparing release",
    authStart: "Verifying GitHub CLI authentication...",
    authDone: "GitHub CLI authenticated.",
    collectStart: "Collecting release context...",
    collectDone: "Release context collected.",
    language: "Language",
    confidence: "confidence",
    reason: "reason",
    dryRunHeader: "Dry run - release not created",
    confirm: "Create release now?",
    cancelled: "Release cancelled.",
    createStart: "Creating GitHub release...",
    createDone: "Release created.",
    notesPreview: "Release notes preview",
    tagQuestion: "Which tag should be released?",
    customTagQuestion: "Enter the release tag (vX.Y.Z):",
    tagEmpty: "Tag cannot be empty.",
    tagInvalid: "Invalid format. Use vX.Y.Z.",
    recommended: "recommended",
    custom: "custom",
    typeCounts: "Commit type counts",
    ready: "Release ready",
  },
  pt: {
    intro: "ghprai — preparando release",
    authStart: "Validando autenticacao do GitHub CLI...",
    authDone: "GitHub CLI autenticado.",
    collectStart: "Coletando contexto da release...",
    collectDone: "Contexto da release coletado.",
    language: "Idioma",
    confidence: "confianca",
    reason: "motivo",
    dryRunHeader: "Dry run - release nao foi criada",
    confirm: "Criar release agora?",
    cancelled: "Release cancelada.",
    createStart: "Criando release no GitHub...",
    createDone: "Release criada.",
    notesPreview: "Preview das release notes",
    tagQuestion: "Qual tag voce quer publicar?",
    customTagQuestion: "Informe a tag da release (vX.Y.Z):",
    tagEmpty: "Tag nao pode ser vazia.",
    tagInvalid: "Formato invalido. Use vX.Y.Z.",
    recommended: "recomendada",
    custom: "custom",
    typeCounts: "Contagem de tipos de commit",
    ready: "Release pronta",
  },
} as const;

const getMessages = (lang: ReleaseLanguage): (typeof MESSAGES)[ReleaseLanguage] => MESSAGES[lang];

const formatCounts = (context: ReleaseContext): string => {
  const counts = countCommitTypes(context.commits);
  const orderedKeys = ["feat", "fix", "perf", "docs", "chore", "refactor", "test", "build", "ci", "deps", "misc"];

  return orderedKeys
    .filter((key) => (counts[key] ?? 0) > 0)
    .map((key) => `- ${key}: ${counts[key] ?? 0}`)
    .join("\n");
};

const selectTag = async (context: ReleaseContext): Promise<string | undefined> => {
  const t = getMessages(context.language);
  const { suggestion } = context;

  const choice = await p.select({
    message: t.tagQuestion,
    options: [
      {
        value: suggestion.suggestedTag,
        label: `${suggestion.suggestedTag} (${t.recommended})`,
        hint: suggestion.reason,
      },
      { value: suggestion.patchTag, label: suggestion.patchTag },
      { value: suggestion.minorTag, label: suggestion.minorTag },
      { value: suggestion.majorTag, label: suggestion.majorTag },
      { value: "custom", label: t.custom },
    ],
  });

  if (p.isCancel(choice)) {
    return undefined;
  }

  if (choice !== "custom") {
    return choice;
  }

  const customTag = await p.text({
    message: t.customTagQuestion,
    validate: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return t.tagEmpty;
      if (!/^v\d+\.\d+\.\d+$/.test(trimmed)) {
        return t.tagInvalid;
      }
      return undefined;
    },
  });

  if (p.isCancel(customTag)) {
    return undefined;
  }

  return customTag.trim();
};

export const runReleaseCreateCommand = async (options: ReleaseCreateOptions): Promise<void> => {
  p.intro(`${MESSAGES.en.intro}${options.dryRun ? " (dry run)" : ""}`);

  const authSpinner = p.spinner();
  authSpinner.start(MESSAGES.en.authStart);
  await verifyGhAuth();
  authSpinner.stop(MESSAGES.en.authDone);

  const contextSpinner = p.spinner();
  contextSpinner.start(MESSAGES.en.collectStart);
  const context = await prepareReleaseContext(options);
  const t = getMessages(context.language);
  contextSpinner.stop(
    `${t.collectDone} ${context.sourceBranch} -> ${context.baseBranch} (${context.lastTag}..origin/${context.baseBranch})`
  );

  p.note(
    [
      `repo: ${context.repoSlug}`,
      `base: ${context.baseBranch}`,
      `source: ${context.sourceBranch}`,
      `${t.language}: ${context.language} (${t.confidence} ${Math.round(context.languageConfidence * 100)}%)`,
      `${t.reason}: ${context.languageReason}`,
      "",
      formatCounts(context),
    ].join("\n"),
    t.typeCounts
  );

  let selectedTag: string | undefined = options.tag?.trim();
  if (!selectedTag) {
    selectedTag = await selectTag(context);
    if (!selectedTag) {
      p.cancel(t.cancelled);
      return;
    }
  }

  validateTag(selectedTag);
  await ensureTagDoesNotExist(selectedTag);

  const notes = buildReleaseNotes(context, selectedTag);
  p.note(notes, t.notesPreview);

  if (options.dryRun) {
    p.outro(`${t.dryRunHeader}: ${selectedTag}`);
    return;
  }

  if (!options.yes) {
    const confirmed = await p.confirm({ message: t.confirm, initialValue: true });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel(t.cancelled);
      return;
    }
  }

  const createSpinner = p.spinner();
  createSpinner.start(t.createStart);
  const url = await createRelease({ tag: selectedTag, baseBranch: context.baseBranch, notes });
  createSpinner.stop(t.createDone);

  p.outro(`${t.ready}: ${url}`);
};
