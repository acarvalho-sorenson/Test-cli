import type { PrInlineComment } from "../types/index.js";

const DIFF_HEADER_REGEX = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER_REGEX = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

export interface DiffIndex {
  changedFiles: Set<string>;
  commentableLinesByFile: Map<string, Set<number>>;
  lineTextByFile: Map<string, Map<number, string>>;
}

const getOrCreateLineSet = (map: Map<string, Set<number>>, path: string): Set<number> => {
  const existing = map.get(path);
  if (existing) return existing;
  const created = new Set<number>();
  map.set(path, created);
  return created;
};

const getOrCreateLineMap = (map: Map<string, Map<number, string>>, path: string): Map<number, string> => {
  const existing = map.get(path);
  if (existing) return existing;
  const created = new Map<number, string>();
  map.set(path, created);
  return created;
};

export const buildDiffIndex = (patch: string): DiffIndex => {
  const lines = patch.split("\n");
  const changedFiles = new Set<string>();
  const commentableLinesByFile = new Map<string, Set<number>>();
  const lineTextByFile = new Map<string, Map<number, string>>();

  let currentFile: string | undefined;
  let rightSideLineNumber = 0;
  let inHunk = false;

  for (const line of lines) {
    const diffHeaderMatch = line.match(DIFF_HEADER_REGEX);
    if (diffHeaderMatch?.[2]) {
      currentFile = diffHeaderMatch[2];
      changedFiles.add(currentFile);
      inHunk = false;
      continue;
    }

    if (!currentFile) {
      continue;
    }

    const hunkMatch = line.match(HUNK_HEADER_REGEX);
    if (hunkMatch?.[1]) {
      rightSideLineNumber = Number.parseInt(hunkMatch[1], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    const lineSet = getOrCreateLineSet(commentableLinesByFile, currentFile);
    const lineMap = getOrCreateLineMap(lineTextByFile, currentFile);

    if (line.startsWith("+") && !line.startsWith("+++")) {
      lineSet.add(rightSideLineNumber);
      lineMap.set(rightSideLineNumber, line.slice(1));
      rightSideLineNumber += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      lineSet.add(rightSideLineNumber);
      lineMap.set(rightSideLineNumber, line.slice(1));
      rightSideLineNumber += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }

    if (line.startsWith("\\")) {
      continue;
    }

    inHunk = false;
  }

  return { changedFiles, commentableLinesByFile, lineTextByFile };
};

export const filterValidInlineComments = (
  comments: PrInlineComment[],
  diffIndex: DiffIndex
): {
  valid: PrInlineComment[];
  invalidCount: number;
} => {
  const valid: PrInlineComment[] = [];
  let invalidCount = 0;

  for (const comment of comments) {
    if (!diffIndex.changedFiles.has(comment.path)) {
      invalidCount += 1;
      continue;
    }

    const fileLines = diffIndex.commentableLinesByFile.get(comment.path);
    if (!fileLines || !fileLines.has(comment.line)) {
      invalidCount += 1;
      continue;
    }

    valid.push(comment);
  }

  return { valid, invalidCount };
};

export const hasTokenNearLine = (
  diffIndex: DiffIndex,
  path: string,
  line: number,
  token: string,
  radius = 3
): boolean => {
  const lineMap = diffIndex.lineTextByFile.get(path);
  if (!lineMap) {
    return false;
  }

  for (let currentLine = line - radius; currentLine <= line + radius; currentLine += 1) {
    const lineText = lineMap.get(currentLine);
    if (lineText?.includes(token)) {
      return true;
    }
  }

  return false;
};
