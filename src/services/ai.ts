import { execa } from "execa";
import { z } from "zod";
import { AiError } from "../errors/index.js";
import type {
  AiBackend,
  AiBackendInfo,
  GitContext,
  PrInlineComment,
  PrPayload,
  PrReviewAction,
  PrReviewContext,
  PrReviewPayload,
} from "../types/index.js";

const MAX_DIFF_CHARS = 30_000;
const MAX_REVIEW_PATCH_CHARS_PER_FILE = 3_000;
const MAX_REVIEW_TOTAL_PATCH_CHARS = 28_000;

let cachedBackend: AiBackendInfo | null | undefined = undefined;

const prPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

const reviewItemObjectSchema = z.object({
  title: z.string().optional(),
  name: z.string().optional(),
  detail: z.string().optional(),
  description: z.string().optional(),
  reason: z.string().optional(),
  suggestion: z.string().optional(),
  message: z.string().optional(),
  action: z.string().optional(),
  impact: z.string().optional(),
});

const inlineCommentSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  title: z.string().optional(),
  detail: z.string().optional(),
  description: z.string().optional(),
  message: z.string().optional(),
});

const reviewItemSchema = z.union([z.string(), reviewItemObjectSchema]);

const prReviewPayloadSchema = z.object({
  summary: z.string().min(1),
  suggestions: z.array(reviewItemSchema).max(12),
  securityConcerns: z.array(reviewItemSchema).max(10),
  recommendedAction: z.string().optional(),
  reviewComment: z.string().min(1),
  inlineComments: z.array(inlineCommentSchema).optional(),
});

const checkCommandExists = async (cmd: string): Promise<boolean> => {
  const result = await execa("which", [cmd], { reject: false });
  return result.exitCode === 0;
};

export const detectAiBackend = async (): Promise<AiBackendInfo> => {
  if (cachedBackend !== undefined) {
    if (cachedBackend === null) throw new AiError(buildNoBackendError());
    return cachedBackend;
  }

  if (process.env["ANTHROPIC_API_KEY"]) {
    cachedBackend = { type: "anthropic-sdk", label: "Anthropic SDK (ANTHROPIC_API_KEY)" };
    return cachedBackend;
  }

  if (process.env["OPENAI_API_KEY"]) {
    cachedBackend = { type: "openai-sdk", label: "OpenAI SDK (OPENAI_API_KEY)" };
    return cachedBackend;
  }

  if (await checkCommandExists("claude")) {
    cachedBackend = { type: "claude-cli", label: "claude CLI (Claude Code)" };
    return cachedBackend;
  }

  if (await checkCommandExists("cursor")) {
    cachedBackend = { type: "cursor-cli", label: "cursor CLI" };
    return cachedBackend;
  }

  if (await checkCommandExists("opencode")) {
    cachedBackend = { type: "opencode-cli", label: "opencode CLI" };
    return cachedBackend;
  }

  if (await checkCommandExists("codex")) {
    cachedBackend = { type: "codex-cli", label: "codex CLI" };
    return cachedBackend;
  }

  if (await checkCommandExists("llm")) {
    cachedBackend = { type: "llm-cli", label: "llm CLI" };
    return cachedBackend;
  }

  cachedBackend = null;
  throw new AiError(buildNoBackendError());
};

const buildNoBackendError = (): string =>
  [
    "No AI backend detected. One of the following is required:",
    "  1. Set ANTHROPIC_API_KEY in your shell profile (export ANTHROPIC_API_KEY=sk-ant-...)",
    "  2. Set OPENAI_API_KEY in your shell profile (export OPENAI_API_KEY=sk-...)",
    "  3. Install Claude Code CLI: https://claude.ai/code",
    "  4. Install one CLI backend: cursor, opencode, codex, or llm",
  ].join("\n");

const buildSystemPrompt = (): string =>
  `You are an expert software engineer writing a GitHub Pull Request description.
Your output must be valid Markdown and must strictly follow the structure of the template provided.
Be concise and precise. Write in the same language as the template (detect it from the section headings).
Never invent changes that are not present in the diff. If you cannot determine a value, leave the HTML comment placeholder in place.
Return a JSON object with exactly two keys: "title" and "body".
The "title" should be a short, imperative-mood PR title (50 chars max, no trailing period).
The "body" should be the fully populated template.
Return ONLY raw JSON — no markdown code fences, no explanation, no extra text.`;

const buildUserPrompt = (context: GitContext, template: string): string => {
  const truncatedDiff =
    context.diff.length > MAX_DIFF_CHARS
      ? `${context.diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated — ${context.diff.length} total chars]`
      : context.diff;

  return `## Branch Information
- Current branch: \`${context.currentBranch}\`
- Target branch: \`${context.targetBranch}\`

## Commit Log
\`\`\`
${context.commitLog.trim() || "(no commits ahead of target)"}
\`\`\`

## Git Diff
\`\`\`diff
${truncatedDiff.trim() || "(empty diff — no changes detected)"}
\`\`\`

## PR Template to populate
${template}

---
Return ONLY a raw JSON object with keys "title" and "body". No markdown code fences, no explanation.`;
};

const buildReviewSystemPrompt = (): string =>
  `You are a senior reviewer generating a constructive pull request review suggestion.
You focus on clean code principles: meaningful naming, small functions, single responsibility,
avoiding magic values, DRY, consistent formatting, testability, and graceful error handling.
Also analyze security concerns, including potential secret exposure and unsafe code execution.
Use a friendly and collaborative tone. Suggestions are recommendations, not absolute truth.
Return a JSON object with exactly these keys:
- summary: one short paragraph
- suggestions: array of actionable improvements (prefer simple strings)
- securityConcerns: array of security concerns (empty array if none, prefer simple strings)
- recommendedAction: one of "comment", "approve", "request-changes"
- reviewComment: markdown text that can be posted as a GitHub PR review
- inlineComments: optional array of inline comments with { path, line, title, detail }
If you use objects in suggestions/securityConcerns, keep fields concise and predictable, such as:
{ "title": "...", "detail": "..." }
For inlineComments, only use paths and line numbers from the provided diff. Do not invent files or lines.
Do not suggest changes outside modified files. Do not claim something is missing when it already
appears in nearby lines.
Keep output compact:
- summary: <= 240 chars
- max 6 suggestions
- max 4 inlineComments
- each inline title/detail short and objective
Return ONLY raw JSON.`;

const buildReviewUserPrompt = (params: {
  context: PrReviewContext;
  securityWarnings: string[];
  inlineRequested?: boolean;
  customInstruction?: string;
  preferredMode?: PrReviewAction;
}): string => {
  const { context, securityWarnings, inlineRequested, customInstruction, preferredMode } = params;
  const customSection = customInstruction?.trim()
    ? `\n## Custom reviewer instruction\n${customInstruction.trim()}\n`
    : "";
  const preferredSection = preferredMode
    ? `\n## Preferred review action\nPrefer this mode when suitable: ${preferredMode}\n`
    : "";
  const inlineSection = inlineRequested
    ? "\n## Inline comments requested\nProvide up to 4 precise inlineComments from changed lines in the diff.\n"
    : "\n## Inline comments requested\ninlineComments can be an empty array if no precise line comments are needed.\n";
  let usedPatchChars = 0;
  const scopedFileDiffSection = context.changedFileDiffs
    .map((file) => {
      const rawPatch = file.patch.trim();
      if (usedPatchChars >= MAX_REVIEW_TOTAL_PATCH_CHARS) {
        return `### ${file.path}\n(patch omitted due prompt size limits)`;
      }

      const fileLimitedPatch =
        rawPatch.length > MAX_REVIEW_PATCH_CHARS_PER_FILE
          ? `${rawPatch.slice(0, MAX_REVIEW_PATCH_CHARS_PER_FILE)}\n\n[patch truncated for prompt size]`
          : rawPatch;

      const remainingChars = MAX_REVIEW_TOTAL_PATCH_CHARS - usedPatchChars;
      const finalPatch =
        fileLimitedPatch.length > remainingChars
          ? `${fileLimitedPatch.slice(0, remainingChars)}\n\n[patch truncated by total limit]`
          : fileLimitedPatch;

      usedPatchChars += finalPatch.length;

      const patch = finalPatch.trim();
      return patch.length > 0
        ? `### ${file.path}\n\`\`\`diff\n${patch}\n\`\`\``
        : `### ${file.path}\n(binary or no patch available)`;
    })
    .join("\n\n");

  return `## Pull Request
- Number: #${context.number}
- Title: ${context.title}
- Author: @${context.authorLogin}
- Base: ${context.baseRefName}
- Head: ${context.headRefName}
- Files changed: ${context.filesChanged}
- Additions: ${context.additions}
- Deletions: ${context.deletions}
- URL: ${context.url}

## Modified files (strict scope)
${context.changedFilesPaths.map((path) => `- ${path}`).join("\n")}

## Existing PR body
${context.body || "(empty)"}

## Security scan warnings
${securityWarnings.length > 0 ? securityWarnings.map((warning) => `- ${warning}`).join("\n") : "- No deterministic warnings detected."}

## Scoped file diffs (only modified files)
${scopedFileDiffSection}
${inlineSection}${customSection}${preferredSection}
---
Remember: stay friendly, avoid claiming certainty, and provide practical suggestions.
Strictly scope all suggestions to modified files and the provided diff lines.
Return ONLY raw JSON.`;
};

const stripCodeFences = (raw: string): string =>
  raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

const parseJsonWithSchema = <TSchema extends z.ZodTypeAny>(
  raw: string,
  schema: TSchema
): z.infer<TSchema> => {
  const cleaned = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new AiError(`AI returned non-JSON output:\n${raw.slice(0, 500)}`);
  }

  const validation = schema.safeParse(parsed);
  if (!validation.success) {
    throw new AiError(`AI returned unexpected JSON shape:\n${validation.error.message}`);
  }

  return validation.data;
};

const parsePrPayloadResponse = (raw: string): PrPayload => {
  const parsed = parseJsonWithSchema(raw, prPayloadSchema);
  return { title: parsed.title, body: parsed.body };
};

const parseReviewPayloadResponse = (raw: string): PrReviewPayload => {
  const parsed = parseJsonWithSchema(raw, prReviewPayloadSchema);
  const normalizedAction = normalizeReviewAction(parsed.recommendedAction);
  return {
    summary: parsed.summary,
    suggestions: normalizeReviewItems(parsed.suggestions),
    securityConcerns: normalizeReviewItems(parsed.securityConcerns),
    recommendedAction: normalizedAction,
    reviewComment: parsed.reviewComment,
    inlineComments: normalizeInlineComments(parsed.inlineComments ?? []),
  };
};

const normalizeReviewAction = (value: string | undefined): PrReviewAction => {
  if (value === "approve" || value === "request-changes") {
    return value;
  }
  return "comment";
};

const extractFirstString = (
  source: Record<string, unknown>,
  keys: ReadonlyArray<string>
): string | undefined => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
};

const normalizeReviewItem = (item: z.infer<typeof reviewItemSchema>): string => {
  if (typeof item === "string") {
    return item.trim();
  }

  const title = extractFirstString(item, ["title", "name"]);
  const detail = extractFirstString(item, [
    "detail",
    "description",
    "reason",
    "suggestion",
    "message",
    "action",
    "impact",
  ]);

  if (title && detail) {
    return `${title} - ${detail}`;
  }

  if (title) {
    return title;
  }

  if (detail) {
    return detail;
  }

  return "Suggestion without details";
};

const normalizeReviewItems = (items: Array<z.infer<typeof reviewItemSchema>>): string[] =>
  items
    .map(normalizeReviewItem)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

const normalizeInlineComments = (items: Array<z.infer<typeof inlineCommentSchema>>): PrInlineComment[] =>
  items
    .map((item) => {
      const path = item.path.trim();
      const title = item.title?.trim() || "Suggestion";
      const detail =
        item.detail?.trim() || item.description?.trim() || item.message?.trim() || "Review suggestion";
      return {
        path,
        line: item.line,
        title,
        detail,
      };
    })
    .filter((item) => item.path.length > 0);

const buildFallbackReviewPayload = (params: {
  preferredMode?: PrReviewAction;
  reason: string;
}): PrReviewPayload => ({
  summary: "AI response could not be parsed. Returning a safe scoped fallback.",
  suggestions: [],
  securityConcerns: [],
  recommendedAction: params.preferredMode ?? "comment",
  reviewComment: [
    "## Review Summary",
    "No actionable issues were produced by the AI response parser for this scoped diff.",
    "",
    `Parser note: ${params.reason}`,
  ].join("\n"),
  inlineComments: [],
});

const parseReviewPayloadWithFallback = (
  raw: string,
  preferredMode?: PrReviewAction
): PrReviewPayload => {
  try {
    return parseReviewPayloadResponse(raw);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "unknown parser error";
    return buildFallbackReviewPayload({ preferredMode, reason });
  }
};

const loadOpenAiClient = async (): Promise<{
  chat: {
    completions: {
      create: (params: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        response_format: { type: "json_object" };
      }) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;
    };
  };
}> => {
  const dynamicImport = new Function(
    "moduleName",
    "return import(moduleName);"
  ) as (moduleName: string) => Promise<unknown>;

  const moduleValue = await dynamicImport("openai").catch(() => {
    throw new AiError(
      "OPENAI_API_KEY is configured but OpenAI SDK is not installed. Run `pnpm add openai`."
    );
  });

  const openAiModule = moduleValue as { default?: new (params: { apiKey: string }) => unknown };
  if (!openAiModule.default) {
    throw new AiError("Could not load OpenAI SDK default export.");
  }

  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new AiError("OPENAI_API_KEY is set but empty.");
  }

  return new openAiModule.default({ apiKey }) as {
    chat: {
      completions: {
        create: (params: {
          model: string;
          messages: Array<{ role: "system" | "user"; content: string }>;
          response_format: { type: "json_object" };
        }) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;
      };
    };
  };
};

const generateViaAnthropicSdk = async (
  systemPrompt: string,
  userPrompt: string
): Promise<string> => {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new AiError("ANTHROPIC_API_KEY is set but empty.");

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const response = await client.messages
    .create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    })
    .catch((err: unknown) => {
      throw new AiError(`Anthropic API request failed: ${String(err)}`);
    });

  const block = response.content[0];
  if (!block || block.type !== "text") {
    throw new AiError("Unexpected response type from Anthropic API.");
  }

  return block.text;
};

const generateViaOpenAiSdk = async (
  systemPrompt: string,
  userPrompt: string
): Promise<string> => {
  const client = await loadOpenAiClient();
  const response = await client.chat.completions
    .create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    })
    .catch((err: unknown) => {
      throw new AiError(`OpenAI API request failed: ${String(err)}`);
    });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new AiError("OpenAI SDK returned an empty response.");
  }

  return content;
};

const generateViaCli = async (
  backend: Extract<
    AiBackend,
    "claude-cli" | "cursor-cli" | "opencode-cli" | "codex-cli" | "llm-cli"
  >,
  systemPrompt: string,
  userPrompt: string
): Promise<string> => {
  const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

  const specs: Record<typeof backend, { command: string; variants: string[][] }> = {
    "claude-cli": { command: "claude", variants: [["-p", fullPrompt]] },
    "cursor-cli": {
      command: "cursor",
      variants: [
        ["-p", fullPrompt],
        ["chat", "--prompt", fullPrompt],
      ],
    },
    "opencode-cli": {
      command: "opencode",
      variants: [
        ["-p", fullPrompt],
        ["prompt", fullPrompt],
      ],
    },
    "codex-cli": {
      command: "codex",
      variants: [
        ["-p", fullPrompt],
        ["prompt", fullPrompt],
      ],
    },
    "llm-cli": { command: "llm", variants: [["-s", systemPrompt, userPrompt]] },
  };

  const currentSpec = specs[backend];
  const failures: string[] = [];

  for (const args of currentSpec.variants) {
    const result = await execa(currentSpec.command, args, { reject: false });
    if (result.exitCode === 0) {
      return result.stdout;
    }
    failures.push(result.stderr || result.stdout || "unknown error");
  }

  throw new AiError(`${currentSpec.command} CLI failed: ${failures.join(" | ")}`);
};

export const generatePrPayload = async (
  context: GitContext,
  template: string
): Promise<PrPayload> => {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(context, template);
  const backend = await detectAiBackend();

  if (backend.type === "anthropic-sdk") {
    const rawResponse = await generateViaAnthropicSdk(systemPrompt, userPrompt);
    return parsePrPayloadResponse(rawResponse);
  }

  if (backend.type === "openai-sdk") {
    const rawResponse = await generateViaOpenAiSdk(systemPrompt, userPrompt);
    return parsePrPayloadResponse(rawResponse);
  }

  const rawResponse = await generateViaCli(backend.type, systemPrompt, userPrompt);
  return parsePrPayloadResponse(rawResponse);
};

export const generatePrReviewPayload = async (params: {
  context: PrReviewContext;
  sanitizedDiff: string;
  securityWarnings: string[];
  inlineRequested?: boolean;
  customInstruction?: string;
  preferredMode?: PrReviewAction;
}): Promise<PrReviewPayload> => {
  const systemPrompt = buildReviewSystemPrompt();
  const userPrompt = buildReviewUserPrompt(params);
  const backend = await detectAiBackend();

  if (backend.type === "anthropic-sdk") {
    const rawResponse = await generateViaAnthropicSdk(systemPrompt, userPrompt);
    return parseReviewPayloadWithFallback(rawResponse, params.preferredMode);
  }

  if (backend.type === "openai-sdk") {
    const rawResponse = await generateViaOpenAiSdk(systemPrompt, userPrompt);
    return parseReviewPayloadWithFallback(rawResponse, params.preferredMode);
  }

  const rawResponse = await generateViaCli(backend.type, systemPrompt, userPrompt);
  return parseReviewPayloadWithFallback(rawResponse, params.preferredMode);
};
