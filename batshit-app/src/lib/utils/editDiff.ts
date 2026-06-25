const PATCH_START = '*** Begin Patch';
const PATCH_END = '*** End Patch';
const DEFAULT_MAX_BLOCK_LINES = 40;
const DEFAULT_MAX_LINE_LENGTH = 240;
const DEFAULT_DIFF_CONTEXT_LINES = 3;
const DEFAULT_MAX_DIFF_LINES = 4_000;
const DEFAULT_LCS_MAX_CELLS = 2_000_000;

export interface CompactEditPreviewOptions {
  filePath?: string;
  command?: string;
  oldText?: string;
  newText?: string;
  before?: string;
  after?: string;
  allowSummary?: boolean;
}

function normalizeNewlines(value: string) {
  return value.replace(/\r\n?/g, '\n');
}

function truncateLine(line: string, maxLength: number) {
  if (line.length <= maxLength) return line;
  const safeLength = Math.max(0, maxLength - '... [truncated]'.length);
  return `${line.slice(0, safeLength)}... [truncated]`;
}

function compressLines(lines: string[], maxLines: number, maxLineLength: number) {
  const truncatedLines = lines.map((line) => truncateLine(line, maxLineLength));
  if (truncatedLines.length <= maxLines) return truncatedLines;

  const headCount = Math.max(1, Math.ceil(maxLines / 2));
  const tailCount = Math.max(1, Math.floor(maxLines / 2));
  const omittedCount = truncatedLines.length - headCount - tailCount;

  return [
    ...truncatedLines.slice(0, headCount),
    `... ${omittedCount} line${omittedCount === 1 ? '' : 's'} omitted ...`,
    ...truncatedLines.slice(-tailCount),
  ];
}

function formatPatchBlock(prefix: '-' | '+', text: string) {
  const normalized = normalizeNewlines(text);
  if (!normalized.length) return [] as string[];

  return compressLines(
    normalized.split('\n'),
    DEFAULT_MAX_BLOCK_LINES,
    DEFAULT_MAX_LINE_LENGTH,
  ).map((line) => `${prefix} ${line}`);
}

type DiffOp =
  | { kind: 'equal'; oldLine: number; newLine: number; text: string }
  | { kind: 'delete'; oldLine: number; text: string }
  | { kind: 'add'; newLine: number; text: string };

function formatLineNumber(value: number) {
  return value.toString().padStart(3);
}

function formatDiffOp(op: DiffOp) {
  const text = truncateLine(op.text, DEFAULT_MAX_LINE_LENGTH);
  if (op.kind === 'add') return `+ ${formatLineNumber(op.newLine)} | ${text}`;
  if (op.kind === 'delete') return `- ${formatLineNumber(op.oldLine)} | ${text}`;
  return `  ${formatLineNumber(op.oldLine)} | ${text}`;
}

function limitDiffLines(lines: string[]) {
  if (lines.length <= DEFAULT_MAX_DIFF_LINES) return lines;

  const headCount = Math.max(2, Math.ceil(DEFAULT_MAX_DIFF_LINES / 2));
  const tailCount = Math.max(2, Math.floor(DEFAULT_MAX_DIFF_LINES / 2));
  const omittedCount = lines.length - headCount - tailCount;

  return [
    ...lines.slice(0, headCount),
    `... ${omittedCount.toLocaleString()} diff line${omittedCount === 1 ? '' : 's'} omitted ...`,
    ...lines.slice(-tailCount),
  ];
}

function formatHunkedDiff(ops: DiffOp[]) {
  const changedIndexes = ops
    .map((op, index) => (op.kind === 'equal' ? -1 : index))
    .filter((index) => index >= 0);

  if (changedIndexes.length === 0) return undefined;

  const includedIndexes = new Set<number>();
  for (const index of changedIndexes) {
    const start = Math.max(0, index - DEFAULT_DIFF_CONTEXT_LINES);
    const end = Math.min(ops.length - 1, index + DEFAULT_DIFF_CONTEXT_LINES);
    for (let cursor = start; cursor <= end; cursor += 1) {
      includedIndexes.add(cursor);
    }
  }

  const body: string[] = [];
  let previousIncluded = -1;
  for (let index = 0; index < ops.length; index += 1) {
    if (!includedIndexes.has(index)) continue;
    const gap = index - previousIncluded - 1;
    if (gap > 0) {
      body.push(`... ${gap.toLocaleString()} unchanged line${gap === 1 ? '' : 's'} omitted ...`);
    }
    body.push(formatDiffOp(ops[index]));
    previousIncluded = index;
  }

  return ['--- Before', '+++ After', ...limitDiffLines(body)].join('\n');
}

function buildLcsOps(beforeLines: string[], afterLines: string[]) {
  const rowCount = beforeLines.length + 1;
  const colCount = afterLines.length + 1;
  const cells = rowCount * colCount;
  if (cells > DEFAULT_LCS_MAX_CELLS) return null;

  const dp = new Uint32Array(cells);
  const offset = (row: number, col: number) => row * colCount + col;

  for (let row = beforeLines.length - 1; row >= 0; row -= 1) {
    for (let col = afterLines.length - 1; col >= 0; col -= 1) {
      if (beforeLines[row] === afterLines[col]) {
        dp[offset(row, col)] = dp[offset(row + 1, col + 1)] + 1;
      } else {
        dp[offset(row, col)] = Math.max(dp[offset(row + 1, col)], dp[offset(row, col + 1)]);
      }
    }
  }

  const ops: DiffOp[] = [];
  let row = 0;
  let col = 0;
  let oldLine = 1;
  let newLine = 1;

  while (row < beforeLines.length || col < afterLines.length) {
    if (row < beforeLines.length && col < afterLines.length && beforeLines[row] === afterLines[col]) {
      ops.push({ kind: 'equal', oldLine, newLine, text: beforeLines[row] });
      row += 1;
      col += 1;
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (
      col < afterLines.length &&
      (row >= beforeLines.length || dp[offset(row, col + 1)] > dp[offset(row + 1, col)])
    ) {
      ops.push({ kind: 'add', newLine, text: afterLines[col] });
      col += 1;
      newLine += 1;
      continue;
    }

    if (row < beforeLines.length) {
      ops.push({ kind: 'delete', oldLine, text: beforeLines[row] });
      row += 1;
      oldLine += 1;
    }
  }

  return ops;
}

function buildPrefixSuffixOps(beforeLines: string[], afterLines: string[]) {
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const ops: DiffOp[] = [];
  for (let index = 0; index < prefix; index += 1) {
    ops.push({ kind: 'equal', oldLine: index + 1, newLine: index + 1, text: beforeLines[index] });
  }

  const beforeChangedEnd = beforeLines.length - suffix;
  const afterChangedEnd = afterLines.length - suffix;
  for (let index = prefix; index < beforeChangedEnd; index += 1) {
    ops.push({ kind: 'delete', oldLine: index + 1, text: beforeLines[index] });
  }
  for (let index = prefix; index < afterChangedEnd; index += 1) {
    ops.push({ kind: 'add', newLine: index + 1, text: afterLines[index] });
  }

  for (let offset = 0; offset < suffix; offset += 1) {
    const beforeIndex = beforeLines.length - suffix + offset;
    const afterIndex = afterLines.length - suffix + offset;
    ops.push({
      kind: 'equal',
      oldLine: beforeIndex + 1,
      newLine: afterIndex + 1,
      text: beforeLines[beforeIndex],
    });
  }

  return ops;
}

function buildSnapshotDiff(before: string, after: string) {
  if (before === after) return undefined;

  const beforeLines = normalizeNewlines(before).split('\n');
  const afterLines = normalizeNewlines(after).split('\n');
  const ops = buildLcsOps(beforeLines, afterLines) ?? buildPrefixSuffixOps(beforeLines, afterLines);
  return formatHunkedDiff(ops);
}

function buildCompactReplacementPatch(options: {
  filePath?: string;
  oldText?: string;
  newText?: string;
}) {
  const hasOldText = typeof options.oldText === 'string' && options.oldText.length > 0;
  const hasNewText = typeof options.newText === 'string' && options.newText.length > 0;
  if (!hasOldText && !hasNewText) return undefined;

  const lines = [
    PATCH_START,
    `*** Update File: ${options.filePath || 'file'}`,
    '@@',
  ];

  if (hasOldText) {
    lines.push(...formatPatchBlock('-', options.oldText as string));
  }
  if (hasNewText) {
    lines.push(...formatPatchBlock('+', options.newText as string));
  }

  lines.push(PATCH_END);
  return lines.join('\n');
}

function buildCompactEditSummary(options: {
  filePath?: string;
  after?: string;
}) {
  const target = options.filePath || 'file';
  const lineCount =
    typeof options.after === 'string' && options.after.length > 0
      ? normalizeNewlines(options.after).split('\n').length
      : null;
  const lineHint = lineCount ? ` (${lineCount.toLocaleString()} lines)` : '';
  return `Updated ${target}${lineHint}. Diff unavailable because Batshit could not reconstruct the before/after change.`;
}

export function extractManagedPatchFromSource(source?: string) {
  if (typeof source !== 'string') return undefined;
  const start = source.indexOf(PATCH_START);
  const end = source.indexOf(PATCH_END);
  if (start === -1 || end === -1 || end <= start) return undefined;
  return source.slice(start, end + PATCH_END.length).trim();
}

export function extractManagedPatchFromSources(sources: Array<string | undefined>) {
  for (const source of sources) {
    const extracted = extractManagedPatchFromSource(source);
    if (extracted) return extracted;
  }
  return undefined;
}

export function buildCompactEditPreview(options: CompactEditPreviewOptions) {
  const extractedPatch = extractManagedPatchFromSources([options.command]);
  if (extractedPatch) return extractedPatch;

  const replacementPatch = buildCompactReplacementPatch({
    filePath: options.filePath,
    oldText: options.oldText,
    newText: options.newText,
  });
  if (replacementPatch) return replacementPatch;

  if (typeof options.before === 'string' && typeof options.after === 'string') {
    if (options.before === options.after) return undefined;

    return buildSnapshotDiff(options.before, options.after);
  }

  if (options.filePath && options.allowSummary !== false) {
    return buildCompactEditSummary({
      filePath: options.filePath,
      after: options.after,
    });
  }

  return undefined;
}
