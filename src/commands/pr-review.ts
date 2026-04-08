import * as p from "@clack/prompts";
import { ReviewError } from "../errors/index.js";
import { generatePrReviewPayload, detectAiBackend } from "../services/ai.js";
import { buildDiffIndex, filterValidInlineComments, hasTokenNearLine } from "../services/diff.js";
import {
  getPrReviewContext,
  submitInlinePrReview,
  submitPrReview,
  verifyGhAuth,
} from "../services/github.js";
import { scanDiffForSecurity } from "../services/security.js";
import { confirmReviewSuggestion } from "../prompts/review.js";
import type { PrReviewAction, ReviewCommandOptions } from "../types/index.js";

const formatSuggestionList = (rows: string[]): string =>
  rows.length > 0 ? rows.map((row) => `- ${row}`).join("\n") : "- No suggestions.";

type ReviewStepState = "pending" | "loading" | "done" | "warning";

interface ReviewStep {
  id: string;
  label: string;
  shortLabel: string;
  state: ReviewStepState;
  detail?: string;
}

interface PipelineProgress {
  start: (message: string) => void;
  message: (message: string) => void;
  stop: (message: string) => void;
}

const STEP_ICON: Record<ReviewStepState, string> = {
  pending: "○",
  loading: "◔",
  done: "●",
  warning: "◑",
};

const createReviewSteps = (): ReviewStep[] => [
  { id: "auth", label: "GitHub authentication", shortLabel: "Auth", state: "pending" },
  { id: "backend", label: "AI machine detection", shortLabel: "AI machine", state: "pending" },
  { id: "context", label: "Pull request scope collection", shortLabel: "Scope", state: "pending" },
  { id: "security", label: "Security scan", shortLabel: "Security", state: "pending" },
  { id: "generate", label: "AI suggestion generation", shortLabel: "Generate", state: "pending" },
  { id: "validate", label: "Suggestion validation", shortLabel: "Validate", state: "pending" },
  { id: "submit", label: "Submission", shortLabel: "Submit", state: "pending" },
];

const truncateForTerminal = (text: string): string => {
  const columns = process.stdout.columns;
  if (!columns || columns < 20) {
    return text;
  }

  const maxLength = Math.max(20, columns - 10);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
};

const renderStepsInline = (steps: ReviewStep[]): string =>
  truncateForTerminal(
    [
      steps.map((step) => `${STEP_ICON[step.state]} ${step.shortLabel}`).join(" | "),
      steps.find((step) => step.state === "loading")?.detail,
    ]
      .filter(Boolean)
      .join(" - ")
  );

const shouldAnimatePipeline = (): boolean => {
  const term = process.env.TERM;
  return Boolean(process.stdout.isTTY && process.stderr.isTTY && term && term !== "dumb" && !process.env.CI);
};

const createPipelineProgress = (): PipelineProgress => {
  if (shouldAnimatePipeline()) {
    const spinner = p.spinner();
    return {
      start: (message: string) => spinner.start(message),
      message: (message: string) => spinner.message(message),
      stop: (message: string) => spinner.stop(message),
    };
  }

  let previousMessage = "";

  return {
    start: (message: string) => {
      previousMessage = message;
      p.log.info(message);
    },
    message: (message: string) => {
      if (message === previousMessage) {
        return;
      }
      previousMessage = message;
      p.log.info(message);
    },
    stop: (message: string) => {
      p.log.success(message);
    },
  };
};

const updateStep = (
  steps: ReviewStep[],
  pipelineProgress: PipelineProgress,
  id: string,
  state: ReviewStepState,
  detail: string | undefined
): void => {
  const target = steps.find((step) => step.id === id);
  if (!target) return;
  target.state = state;
  target.detail = detail;
  pipelineProgress.message(renderStepsInline(steps));
};

const VALID_REVIEW_MODES: ReadonlyArray<PrReviewAction> = [
  "comment",
  "approve",
  "request-changes",
];

const isValidReviewMode = (value: string): value is PrReviewAction =>
  VALID_REVIEW_MODES.includes(value as PrReviewAction);

const normalizeMode = (mode: PrReviewAction | undefined, fallback: PrReviewAction): PrReviewAction =>
  mode ?? fallback;

const formatInlinePreview = (rows: Array<{ path: string; line: number; title: string; detail: string }>): string =>
  rows.length > 0
    ? rows.map((row) => `- ${row.path}:${row.line} - ${row.title} - ${row.detail}`).join("\n")
    : "- No inline comments suggested.";

const INLINE_FALLBACK_LIMIT = 10;
const MISSING_CLAIM_REGEX = /\b(missing|absent|ausente|faltando)\b/i;

const buildInlineFallbackSection = (
  failedComments: Array<{ comment: { path: string; line: number; title: string; detail: string }; error: string }>
): string => {
  if (failedComments.length === 0) {
    return "";
  }

  const listed = failedComments.slice(0, INLINE_FALLBACK_LIMIT);
  const lines = listed.map(
    ({ comment }) =>
      `- \`${comment.path}:${comment.line}\` - **${comment.title}** - ${comment.detail}`
  );
  const omittedCount = failedComments.length - listed.length;

  const extraLine =
    omittedCount > 0 ? `\n- _${omittedCount} additional inline suggestion(s) omitted for brevity._` : "";

  return [
    "",
    "---",
    "",
    "### Inline comments that could not be attached",
    "",
    "The suggestions below could not be posted on exact diff lines, so they are included here:",
    "",
    ...lines,
    extraLine,
  ]
    .filter(Boolean)
    .join("\n");
};

const extractQuotedToken = (input: string): string | undefined => {
  const backtickMatch = input.match(/`([^`]+)`/);
  if (backtickMatch?.[1]) {
    return backtickMatch[1];
  }

  const quotedMatch = input.match(/"([^"]+)"|'([^']+)'/);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }
  if (quotedMatch?.[2]) {
    return quotedMatch[2];
  }

  return undefined;
};

const isContradictoryMissingSuggestion = (
  path: string,
  line: number,
  title: string,
  detail: string,
  diffIndex: ReturnType<typeof buildDiffIndex>
): boolean => {
  const text = `${title} ${detail}`;
  if (!MISSING_CLAIM_REGEX.test(text)) {
    return false;
  }

  const token = extractQuotedToken(text);
  if (!token) {
    return false;
  }

  return hasTokenNearLine(diffIndex, path, line, token);
};

const buildScopedSuggestions = (
  comments: Array<{ path: string; line: number; title: string; detail: string }>
): string[] => comments.map((comment) => `${comment.path}:${comment.line} - ${comment.title} - ${comment.detail}`);

const buildScopedReviewComment = (params: {
  changedFilesCount: number;
  suggestions: string[];
  securityConcerns: string[];
}): string => {
  const deterministicSummary =
    params.suggestions.length > 0
      ? `Scoped review found ${params.suggestions.length} actionable suggestion(s) across ${params.changedFilesCount} modified file(s).`
      : `Scoped review found no actionable issues in ${params.changedFilesCount} modified file(s).`;

  const suggestionsSection =
    params.suggestions.length > 0
      ? params.suggestions.map((row) => `- ${row}`).join("\n")
      : "- No actionable issues found strictly in the modified diff lines.";

  const securitySection =
    params.securityConcerns.length > 0
      ? params.securityConcerns.map((row) => `- ${row}`).join("\n")
      : "- No security concerns detected in modified lines.";

  return [
    "## Review Summary",
    deterministicSummary,
    "",
    "## Scoped Suggestions",
    suggestionsSection,
    "",
    "## Security",
    securitySection,
  ].join("\n");
};

const submitReview = async (params: {
  inline: boolean;
  mode: PrReviewAction;
  body: string;
  pr: string;
  reviewContext: Awaited<ReturnType<typeof getPrReviewContext>>;
  inlineComments: Array<{ path: string; line: number; title: string; detail: string }>;
}): Promise<{ inlinePosted: number; inlineFailed: number; inlineFailures: string[] }> => {
  if (params.inline && params.inlineComments.length > 0) {
    const inlineResult = await submitInlinePrReview({
      context: params.reviewContext,
      action: params.mode,
      body: params.body,
      comments: params.inlineComments,
    });

    const reviewBody = `${params.body}${buildInlineFallbackSection(inlineResult.failedComments)}`;

    await submitPrReview({ pr: params.pr, action: params.mode, body: reviewBody });

    return {
      inlinePosted: inlineResult.posted,
      inlineFailed: inlineResult.failed,
      inlineFailures: inlineResult.failures,
    };
  }

  await submitPrReview({ pr: params.pr, action: params.mode, body: params.body });
  return { inlinePosted: 0, inlineFailed: 0, inlineFailures: [] };
};

export const runPrReviewCommand = async (options: ReviewCommandOptions): Promise<void> => {
  if (options.mode && !isValidReviewMode(options.mode)) {
    throw new ReviewError(
      `Invalid --mode value: ${options.mode}. Expected one of: ${VALID_REVIEW_MODES.join(", ")}.`
    );
  }

  const dryRunSuffix = options.dryRun ? " (dry run)" : "";
  p.intro(`ghprai - reviewing PR ${options.pr}${dryRunSuffix}`);
  const reviewSteps = createReviewSteps();
  const pipelineProgress = createPipelineProgress();
  pipelineProgress.start(renderStepsInline(reviewSteps));

  updateStep(reviewSteps, pipelineProgress, "auth", "loading", "Verifying gh auth");
  await verifyGhAuth();
  p.log.success("GitHub CLI authenticated");
  updateStep(reviewSteps, pipelineProgress, "auth", "done", "Authenticated");

  updateStep(reviewSteps, pipelineProgress, "backend", "loading", "Detecting AI machine");
  const backend = await detectAiBackend();
  p.log.success(`Using: ${backend.label}`);
  updateStep(reviewSteps, pipelineProgress, "backend", "done", backend.label);

  updateStep(reviewSteps, pipelineProgress, "context", "loading", `Collecting PR #${options.pr}`);
  const reviewContext = await getPrReviewContext(options.pr);
  p.log.success(
    `PR #${reviewContext.number}: ${reviewContext.headRefName} -> ${reviewContext.baseRefName}`
  );
  updateStep(
    reviewSteps,
    pipelineProgress,
    "context",
    "done",
    `${reviewContext.changedFilesPaths.length} files in scope`
  );

  updateStep(reviewSteps, pipelineProgress, "security", "loading", "Scanning diff");
  const securityScan = scanDiffForSecurity(reviewContext.diff);
  if (securityScan.redactionCount > 0 || securityScan.wasTruncated || securityScan.warnings.length > 0) {
    const securityNotes: string[] = [];
    if (securityScan.redactionCount > 0) {
      securityNotes.push(`- Redacted potential secrets: ${securityScan.redactionCount}`);
    }
    if (securityScan.wasTruncated) {
      securityNotes.push("- Diff was truncated for safety limits.");
    }
    for (const warning of securityScan.warnings) {
      securityNotes.push(`- ${warning}`);
    }
    p.note(securityNotes.join("\n"), "Security checks");
    updateStep(
      reviewSteps,
      pipelineProgress,
      "security",
      "warning",
      `${securityScan.redactionCount} redaction(s), ${securityScan.warnings.length} warning(s)`
    );
  } else {
    updateStep(reviewSteps, pipelineProgress, "security", "done", "No deterministic warnings");
  }

  updateStep(reviewSteps, pipelineProgress, "generate", "loading", "Generating scoped suggestions");
  const reviewPayload = await generatePrReviewPayload({
    context: reviewContext,
    sanitizedDiff: securityScan.sanitizedDiff,
    securityWarnings: securityScan.warnings,
    inlineRequested: options.inline,
    customInstruction: options.instruction,
    preferredMode: options.mode,
  });
  p.log.success("Review suggestion generated");
  updateStep(reviewSteps, pipelineProgress, "generate", "done", "AI payload ready");

  updateStep(reviewSteps, pipelineProgress, "validate", "loading", "Filtering scoped comments");
  const diffIndex = buildDiffIndex(reviewContext.diff);
  const inlineValidation = filterValidInlineComments(reviewPayload.inlineComments, diffIndex);
  const scopedInlineComments = inlineValidation.valid.filter(
    (comment) =>
      !isContradictoryMissingSuggestion(
        comment.path,
        comment.line,
        comment.title,
        comment.detail,
        diffIndex
      )
  );
  const contradictoryDroppedCount = inlineValidation.valid.length - scopedInlineComments.length;

  const inlineScopedSuggestions = buildScopedSuggestions(scopedInlineComments);
  const scopedSuggestions =
    reviewPayload.suggestions.length > 0 ? reviewPayload.suggestions : inlineScopedSuggestions;
  const scopedReviewBody = buildScopedReviewComment({
    changedFilesCount: reviewContext.changedFilesPaths.length,
    suggestions: scopedSuggestions,
    securityConcerns: reviewPayload.securityConcerns,
  });
  updateStep(
    reviewSteps,
    pipelineProgress,
    "validate",
    "done",
    `${scopedInlineComments.length} inline suggestion(s) remain`
  );

  if (options.inline && inlineValidation.invalidCount > 0) {
    p.note(
      `Ignored ${inlineValidation.invalidCount} inline suggestion(s) with invalid file/line references.`,
      "Inline validation"
    );
  }

  if (options.inline && contradictoryDroppedCount > 0) {
    p.note(
      `Ignored ${contradictoryDroppedCount} contradictory suggestion(s) because the claimed missing token exists in nearby diff lines.`,
      "Suggestion validation"
    );
  }

  if (options.inline && inlineValidation.valid.length === 0) {
    p.note(
      "No valid inline comments were generated. The review will be submitted as a general PR review.",
      "Inline fallback"
    );
  }

  p.note(
    [
      `Summary: Scoped review generated for ${reviewContext.changedFilesPaths.length} modified file(s).`,
      "",
      "Suggestions:",
      formatSuggestionList(scopedSuggestions),
      "",
      "Security concerns:",
      formatSuggestionList(reviewPayload.securityConcerns),
      "",
      `Recommended action: ${reviewPayload.recommendedAction}`,
      "",
      "Inline comments:",
      formatInlinePreview(scopedInlineComments),
    ].join("\n"),
    "AI review result"
  );

  const selectedMode = normalizeMode(options.mode, reviewPayload.recommendedAction);

  if (options.dryRun) {
    updateStep(reviewSteps, pipelineProgress, "submit", "done", "Dry run only");
    pipelineProgress.stop("Review pipeline completed.");
    p.note(scopedReviewBody, `Dry run - ${selectedMode}`);
    if (options.inline) {
      p.note(
        `${scopedInlineComments.length} inline comment(s) ready for submission.`,
        "Inline dry run"
      );
    }
    p.outro("Done (dry run). No review was submitted.");
    return;
  }

  if (options.mode) {
    updateStep(
      reviewSteps,
      pipelineProgress,
      "submit",
      "loading",
      `Submitting as ${options.mode}`
    );
    const submitResult = await submitReview({
      inline: options.inline,
      mode: options.mode,
      body: scopedReviewBody,
      pr: options.pr,
      reviewContext,
      inlineComments: scopedInlineComments,
    });
    p.log.success("Review submitted");
    if (submitResult.inlineFailed > 0) {
      p.note(
        [
          `Inline comments posted: ${submitResult.inlinePosted}`,
          `Inline comments converted to general review: ${submitResult.inlineFailed}`,
          submitResult.inlineFailures[0] ? `First failure: ${submitResult.inlineFailures[0]}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        "Inline submission"
      );
    }
    updateStep(reviewSteps, pipelineProgress, "submit", "done", "Review submitted");
    pipelineProgress.stop("Review pipeline completed.");
    p.outro(`Review posted on ${reviewContext.url}`);
    return;
  }

  const confirmation = await confirmReviewSuggestion(selectedMode, scopedReviewBody);
  if (confirmation.action === "ignore") {
    updateStep(reviewSteps, pipelineProgress, "submit", "done", "Suggestion ignored");
    pipelineProgress.stop("Review pipeline completed.");
    p.outro("Done. Suggestion ignored by user choice.");
    return;
  }

  updateStep(
    reviewSteps,
    pipelineProgress,
    "submit",
    "loading",
    `Submitting as ${confirmation.mode}`
  );
  const submitResult = await submitReview({
    inline: options.inline,
    mode: confirmation.mode,
    body: confirmation.body,
    pr: options.pr,
    reviewContext,
    inlineComments: scopedInlineComments,
  });
  p.log.success("Review submitted");

  if (submitResult.inlineFailed > 0) {
    p.note(
      [
        `Inline comments posted: ${submitResult.inlinePosted}`,
        `Inline comments converted to general review: ${submitResult.inlineFailed}`,
        submitResult.inlineFailures[0] ? `First failure: ${submitResult.inlineFailures[0]}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      "Inline submission"
    );
  }

  updateStep(reviewSteps, pipelineProgress, "submit", "done", "Review submitted");
  pipelineProgress.stop("Review pipeline completed.");

  p.outro(`Review posted on ${reviewContext.url}`);
};
