/**
 * Custom markdownlint fix application helper
 * Since markdownlint-rule-helpers doesn't provide applyFixes function,
 * we implement our own based on the fixInfo structure
 */

/**
 * Apply fixes to markdown content based on markdownlint error fixInfo
 * @param {string} content - Original markdown content
 * @param {Array} errors - Array of markdownlint errors with fixInfo
 * @returns {string} Fixed markdown content
 */
function applyMarkdownlintFixes(content, errors) {
  if (!content || !errors || errors.length === 0) {
    return content;
  }

  // Filter errors that have fixInfo
  const fixableErrors = errors.filter(error => error.fixInfo);
  
  if (fixableErrors.length === 0) {
    return content;
  }

  // Split content into lines for easier manipulation
  const lines = content.split('\n');
  
  // Sort errors by line number (descending) and column (descending) to avoid offset issues
  const sortedErrors = fixableErrors.sort((a, b) => {
    if (a.lineNumber !== b.lineNumber) {
      return b.lineNumber - a.lineNumber; // Descending line number
    }
    // For same line, sort by column descending
    const aCol = a.fixInfo.editColumn || 1;
    const bCol = b.fixInfo.editColumn || 1;
    return bCol - aCol;
  });

  // Apply fixes in reverse order to maintain line/column positions
  for (const error of sortedErrors) {
    const fixInfo = error.fixInfo;
    const lineIndex = (error.lineNumber || 1) - 1; // Convert to 0-based index
    
    if (lineIndex < 0 || lineIndex >= lines.length) {
      continue; // Skip invalid line numbers
    }

    // Handle different types of fixes
    if (fixInfo.deleteCount !== undefined) {
      if (fixInfo.deleteCount < 0) {
        // Negative deleteCount means delete entire lines
        const linesToDelete = Math.abs(fixInfo.deleteCount);
        lines.splice(lineIndex, linesToDelete);
      } else if (fixInfo.editColumn !== undefined) {
        // Delete characters from a specific column
        const line = lines[lineIndex];
        const editColumn = fixInfo.editColumn - 1; // Convert to 0-based index
        const beforeEdit = line.substring(0, editColumn);
        const afterEdit = line.substring(editColumn + fixInfo.deleteCount);
        const insertText = fixInfo.insertText || '';
        lines[lineIndex] = beforeEdit + insertText + afterEdit;
      }
    } else if (fixInfo.insertText !== undefined) {
      if (fixInfo.lineNumber && fixInfo.editColumn === undefined) {
        // Insert new line
        const insertLineIndex = (fixInfo.lineNumber || error.lineNumber) - 1;
        lines.splice(insertLineIndex, 0, fixInfo.insertText.replace(/\n$/, ''));
      } else if (fixInfo.editColumn !== undefined) {
        // Insert text at specific column
        const line = lines[lineIndex];
        const editColumn = fixInfo.editColumn - 1; // Convert to 0-based index
        const beforeEdit = line.substring(0, editColumn);
        const afterEdit = line.substring(editColumn);
        lines[lineIndex] = beforeEdit + fixInfo.insertText + afterEdit;
      } else {
        // Insert at beginning of line
        lines[lineIndex] = fixInfo.insertText + lines[lineIndex];
      }
    }
  }

  return lines.join('\n');
}

module.exports = {
  applyMarkdownlintFixes
};