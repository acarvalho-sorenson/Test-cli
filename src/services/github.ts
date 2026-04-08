import { execa } from "execa";
import { z } from "zod";
import { GhAuthError, ReleaseError, ReviewError } from "../errors/index.js";
import type {
  PrInlineComment,
  PrPayload,
  PrReviewAction,
  PrReviewContext,
} from "../types/index.js";

export const verifyGhAuth = async (): Promise<void> => {
  const result = await execa("gh", ["auth", "status"], { reject: false });
  if (result.exitCode !== 0) {
    throw new GhAuthError(
      "GitHub CLI is not authenticated. Run `gh auth login` first."
    );
  }
};

export const createPr = async (targetBranch: string, payload: PrPayload): Promise<string> => {
  const result = await execa(
    "gh",
    ["pr", "create", "--title", payload.title, "--body", payload.body, "--base", targetBranch],
    { reject: false }
  );
  if (result.exitCode !== 0) {
    throw new GhAuthError(`gh pr create failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  return result.stdout.trim();
};

export const createRelease = async (params: {
  tag: string;
  baseBranch: string;
  notes: string;
}): Promise<string> => {
  const result = await execa(
    "gh",
    [
      "release",
      "create",
      params.tag,
      "--target",
      params.baseBranch,
      "--title",
      params.tag,
      "--notes",
      params.notes,
    ],
    { reject: false }
  );

  if (result.exitCode !== 0) {
    throw new ReleaseError(
      `gh release create failed: ${result.stderr || result.stdout || "unknown error"}`
    );
  }

  return result.stdout.trim();
};

const prViewSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().optional(),
  author: z.object({ login: z.string() }).nullable().optional(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  changedFiles: z.number(),
  additions: z.number(),
  deletions: z.number(),
  url: z.string(),
});

const repoViewSchema = z.object({
  owner: z.object({ login: z.string() }),
  name: z.string(),
});

const prFileSchema = z.object({
  filename: z.string(),
  patch: z.string().optional(),
});

const buildScopedDiff = (files: Array<{ filename: string; patch?: string }>): string =>
  files
    .map((file) => {
      const header = `diff --git a/${file.filename} b/${file.filename}`;
      const patch = file.patch?.trim() ?? "";
      return patch.length > 0 ? `${header}\n${patch}` : `${header}\n(binary or no patch available)`;
    })
    .join("\n\n");

export const getPrReviewContext = async (pr: string): Promise<PrReviewContext> => {
  const viewResult = await execa(
    "gh",
    [
      "pr",
      "view",
      pr,
      "--json",
      "number,title,body,author,headRefOid,baseRefName,headRefName,changedFiles,additions,deletions,url",
    ],
    { reject: false }
  );

  if (viewResult.exitCode !== 0) {
    throw new ReviewError(
      `Could not fetch PR details: ${viewResult.stderr || viewResult.stdout || "unknown error"}`
    );
  }

  let rawData: unknown;
  try {
    rawData = JSON.parse(viewResult.stdout);
  } catch {
    throw new ReviewError("Could not parse `gh pr view` JSON output.");
  }

  const parsed = prViewSchema.safeParse(rawData);
  if (!parsed.success) {
    throw new ReviewError(`Unexpected PR metadata format: ${parsed.error.message}`);
  }

  const repoResult = await execa("gh", ["repo", "view", "--json", "owner,name"], { reject: false });
  if (repoResult.exitCode !== 0) {
    throw new ReviewError(
      `Could not fetch repository details: ${repoResult.stderr || repoResult.stdout || "unknown error"}`
    );
  }

  let rawRepoData: unknown;
  try {
    rawRepoData = JSON.parse(repoResult.stdout);
  } catch {
    throw new ReviewError("Could not parse `gh repo view` JSON output.");
  }

  const parsedRepo = repoViewSchema.safeParse(rawRepoData);
  if (!parsedRepo.success) {
    throw new ReviewError(`Unexpected repository metadata format: ${parsedRepo.error.message}`);
  }

  const changedFilesResult = await execa("gh", ["pr", "diff", pr, "--name-only"], {
    reject: false,
  });

  if (changedFilesResult.exitCode !== 0) {
    throw new ReviewError(
      `Could not fetch changed files: ${changedFilesResult.stderr || changedFilesResult.stdout || "unknown error"}`
    );
  }

  const changedFilesPaths = changedFilesResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const data = parsed.data;
  const repoData = parsedRepo.data;

  const filesResult = await execa(
    "gh",
    ["api", `repos/${repoData.owner.login}/${repoData.name}/pulls/${data.number}/files`, "--paginate"],
    { reject: false }
  );

  if (filesResult.exitCode !== 0) {
    throw new ReviewError(
      `Could not fetch PR file patches: ${filesResult.stderr || filesResult.stdout || "unknown error"}`
    );
  }

  let rawFilesData: unknown;
  try {
    rawFilesData = JSON.parse(filesResult.stdout);
  } catch {
    throw new ReviewError("Could not parse PR files API output.");
  }

  const parsedFiles = z.array(prFileSchema).safeParse(rawFilesData);
  if (!parsedFiles.success) {
    throw new ReviewError(`Unexpected PR file patch format: ${parsedFiles.error.message}`);
  }

  const changedFileDiffs = parsedFiles.data.map((file) => ({
    path: file.filename,
    patch: file.patch ?? "",
  }));

  const scopedDiff = buildScopedDiff(parsedFiles.data);
  return {
    pr,
    number: data.number,
    repoOwner: repoData.owner.login,
    repoName: repoData.name,
    headSha: data.headRefOid,
    changedFilesPaths,
    changedFileDiffs,
    title: data.title,
    body: data.body ?? "",
    authorLogin: data.author?.login ?? "unknown",
    baseRefName: data.baseRefName,
    headRefName: data.headRefName,
    filesChanged: data.changedFiles,
    additions: data.additions,
    deletions: data.deletions,
    url: data.url,
    diff: scopedDiff,
  };
};

export const submitPrReview = async (params: {
  pr: string;
  action: PrReviewAction;
  body: string;
}): Promise<void> => {
  const actionFlagMap: Record<PrReviewAction, string> = {
    comment: "--comment",
    approve: "--approve",
    "request-changes": "--request-changes",
  };

  const result = await execa(
    "gh",
    ["pr", "review", params.pr, actionFlagMap[params.action], "--body", params.body],
    { reject: false }
  );

  if (result.exitCode !== 0) {
    throw new ReviewError(
      `Could not submit PR review: ${result.stderr || result.stdout || "unknown error"}`
    );
  }
};

export const submitInlinePrReview = async (params: {
  context: PrReviewContext;
  action: PrReviewAction;
  body: string;
  comments: PrInlineComment[];
}): Promise<{
  posted: number;
  failed: number;
  failures: string[];
  failedComments: Array<{ comment: PrInlineComment; error: string }>;
}> => {
  const endpoint = `/repos/${params.context.repoOwner}/${params.context.repoName}/pulls/${params.context.number}/comments`;
  const failures: string[] = [];
  const failedComments: Array<{ comment: PrInlineComment; error: string }> = [];
  let posted = 0;

  for (const comment of params.comments) {
    const payload = {
      commit_id: params.context.headSha,
      path: comment.path,
      line: comment.line,
      side: "RIGHT",
      body: `**${comment.title}**\n\n${comment.detail}`,
    };

    const result = await execa("gh", ["api", endpoint, "--method", "POST", "--input", "-"], {
      reject: false,
      input: JSON.stringify(payload),
    });

    if (result.exitCode !== 0) {
      const errorDetails = result.stderr || result.stdout || "unknown error";
      failures.push(`${comment.path}:${comment.line} - ${errorDetails}`);
      failedComments.push({ comment, error: errorDetails });
      continue;
    }

    posted += 1;
  }

  return {
    posted,
    failed: params.comments.length - posted,
    failures,
    failedComments,
  };
};
