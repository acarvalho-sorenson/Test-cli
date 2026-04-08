import { execa } from "execa";
import { GitError } from "../errors/index.js";
import type { GitContext } from "../types/index.js";

const runGit = async (args: string[]): Promise<string> => {
  const result = await execa("git", args, { reject: false });
  if (result.exitCode !== 0) {
    throw new GitError(`git ${args.join(" ")} failed: ${result.stderr || "unknown error"}`);
  }
  return result.stdout;
};

export const getRepoRoot = async (): Promise<string> => {
  const result = await execa("git", ["rev-parse", "--show-toplevel"], { reject: false });
  if (result.exitCode !== 0) {
    throw new GitError("Not inside a git repository or git is unavailable.");
  }
  return result.stdout.trim();
};

export const getCurrentBranch = async (): Promise<string> => {
  const result = await execa("git", ["branch", "--show-current"], { reject: false });
  if (result.exitCode !== 0) {
    throw new GitError("Could not determine current branch.");
  }
  const branch = result.stdout.trim();
  if (!branch) {
    throw new GitError("Could not determine current branch (detached HEAD state?).");
  }
  return branch;
};

export const getDiff = async (targetBranch: string): Promise<string> => {
  const result = await execa(
    "git",
    ["diff", `${targetBranch}...HEAD`, "--stat", "--patch"],
    { reject: false }
  );
  if (result.exitCode !== 0) {
    throw new GitError(
      `git diff failed: ${result.stderr || "unknown error"}. Does branch "${targetBranch}" exist?`
    );
  }
  return result.stdout;
};

export const getCommitLog = async (targetBranch: string): Promise<string> => {
  const result = await execa(
    "git",
    ["log", `${targetBranch}..HEAD`, "--oneline", "--no-merges"],
    { reject: false }
  );
  if (result.exitCode !== 0) {
    throw new GitError(`git log failed: ${result.stderr || "unknown error"}`);
  }
  return result.stdout;
};

export const buildGitContext = async (targetBranch: string): Promise<GitContext> => {
  const repoRoot = await getRepoRoot();
  const [currentBranch, diff, commitLog] = await Promise.all([
    getCurrentBranch(),
    getDiff(targetBranch),
    getCommitLog(targetBranch),
  ]);

  return { currentBranch, targetBranch, diff, commitLog, repoRoot };
};

export const fetchOriginTags = async (): Promise<void> => {
  await runGit(["fetch", "--tags", "origin"]);
};

export const getRemoteDefaultBranch = async (): Promise<string> => {
  const stdout = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD"]);
  const ref = stdout.trim();
  const marker = "refs/remotes/origin/";
  if (!ref.startsWith(marker)) {
    throw new GitError(`Unexpected origin HEAD ref format: ${ref}`);
  }
  return ref.slice(marker.length);
};

export const hasRemoteBranch = async (branch: string): Promise<boolean> => {
  const result = await execa("git", ["show-ref", "--verify", `refs/remotes/origin/${branch}`], {
    reject: false,
  });
  return result.exitCode === 0;
};

export const getLastSemverTag = async (baseBranch: string): Promise<string> => {
  const stdout = await runGit([
    "tag",
    "--merged",
    `origin/${baseBranch}`,
    "--list",
    "v[0-9]*.[0-9]*.[0-9]*",
    "--sort=-v:refname",
  ]);

  const firstTag = stdout
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstTag) {
    throw new GitError(`No semver tags found on origin/${baseBranch} (expected vX.Y.Z).`);
  }

  return firstTag;
};

export const getRepoSlugFromOrigin = async (): Promise<string> => {
  const stdout = await runGit(["remote", "get-url", "origin"]);
  const remoteUrl = stdout.trim();

  const sshMatch = remoteUrl.match(/^git@github\.com:(.+?)(?:\.git)?$/i);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/i);
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }

  throw new GitError(`Could not parse GitHub repository slug from origin URL: ${remoteUrl}`);
};

export const getReleaseCommitsRaw = async (fromRef: string, baseBranch: string): Promise<string> =>
  runGit([
    "log",
    `${fromRef}..origin/${baseBranch}`,
    "--no-merges",
    "--pretty=format:%H%x1f%s%x1f%b%x1e",
  ]);

export const remoteTagExists = async (tag: string): Promise<boolean> => {
  const stdout = await runGit(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
  return stdout.trim().length > 0;
};
