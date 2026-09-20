/**
 * Streaming Prompt Components
 *
 * Prompts for agents that report issues via MCP tool in real-time.
 */

import type { IssueCategory, PRContext } from '../types.js';
import { DIFF_ANALYSIS_INSTRUCTIONS } from './base.js';

/**
 * Get language label for prompt instructions
 */
function getLangLabel(language: 'en' | 'zh'): string {
  return language === 'en' ? 'English' : 'Chinese';
}

function takeFirstNonEmptyLines(text: string, maxLines: number): string {
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  return lines.slice(0, maxLines).join('\n');
}

function takeFirstFileAnalysisEntries(fileAnalyses: string, maxEntries: number): string {
  const lines = fileAnalyses
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  return lines.slice(0, maxEntries).join('\n');
}

function countFileAnalysisEntries(fileAnalyses: string): number {
  return fileAnalyses
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

function buildPrContextSection(
  prContext: PRContext,
  options: { maxIssues?: number; includeKeyPoints: boolean }
): string[] {
  const sections: string[] = [];
  const prIssues = prContext.issues || prContext.jiraIssues || [];
  const issuesToRender =
    typeof options.maxIssues === 'number' ? prIssues.slice(0, options.maxIssues) : prIssues;
  const prDescription = prContext.prDescription?.trim();
  const truncatedPrDescription =
    prDescription && prDescription.length > 3000
      ? `${prDescription.slice(0, 3000)}...`
      : prDescription;

  if (issuesToRender.length === 0 && !truncatedPrDescription) {
    return sections;
  }

  sections.push('## PR Business Context\n');
  sections.push(`**PR Title**: ${prContext.prTitle}\n`);
  if (truncatedPrDescription) {
    sections.push(`**PR Description**: ${truncatedPrDescription}\n`);
  }
  if (issuesToRender.length > 0) {
    sections.push('### Related Issues\n');
    sections.push('以下是与此 PR 相关的 issue，请在 review 时参考这些业务上下文：\n');
    for (const issue of issuesToRender) {
      sections.push(`#### ${issue.key} (${issue.type})`);
      sections.push(`**摘要**: ${issue.summary}\n`);
      if (options.includeKeyPoints && issue.keyPoints.length > 0) {
        sections.push('**关键点**:');
        for (const point of issue.keyPoints) {
          sections.push(`- ${point}`);
        }
        sections.push('');
      }
      sections.push(`**Review 重点**: ${issue.reviewContext}\n`);
    }
  }
  sections.push('---\n');

  return sections;
}

function getPromptContextMode(agentType: string): {
  includePrContext: boolean;
  prContextMaxIssues?: number;
  includeDeletedFiles: boolean;
  includeFileAnalyses: boolean;
  maxFileAnalyses?: number;
  skipFileAnalysesWhenOverLimit: boolean;
  useConciseRules: boolean;
  conciseChecklist: boolean;
  includeKeyPointsInPrContext: boolean;
} {
  switch (agentType) {
    case 'style-reviewer':
      return {
        includePrContext: false,
        includeDeletedFiles: false,
        includeFileAnalyses: true,
        maxFileAnalyses: 5,
        skipFileAnalysesWhenOverLimit: true,
        useConciseRules: true,
        conciseChecklist: true,
        includeKeyPointsInPrContext: false,
      };
    case 'performance-reviewer':
      return {
        includePrContext: true,
        prContextMaxIssues: 3,
        includeDeletedFiles: false,
        includeFileAnalyses: true,
        maxFileAnalyses: 10,
        skipFileAnalysesWhenOverLimit: false,
        useConciseRules: true,
        conciseChecklist: true,
        includeKeyPointsInPrContext: false,
      };
    case 'security-reviewer':
      return {
        includePrContext: true,
        prContextMaxIssues: 3,
        includeDeletedFiles: false,
        includeFileAnalyses: true,
        maxFileAnalyses: 10,
        skipFileAnalysesWhenOverLimit: false,
        useConciseRules: false,
        conciseChecklist: true,
        includeKeyPointsInPrContext: false,
      };
    case 'logic-reviewer':
    default:
      return {
        includePrContext: true,
        includeDeletedFiles: true,
        includeFileAnalyses: true,
        skipFileAnalysesWhenOverLimit: false,
        useConciseRules: false,
        conciseChecklist: true,
        includeKeyPointsInPrContext: true,
      };
  }
}

/**
 * Instructions for using the report_issue tool
 */
export function getReportIssueToolInstructions(language: 'en' | 'zh' = 'zh'): string {
  const lang = getLangLabel(language);
  return `
## Issue Reporting (CRITICAL)

You MUST use the **report_issue** tool to report each issue you find.

**DO NOT** output JSON at the end. Instead, call the report_issue tool immediately when you find each issue.

**Workflow**:
1. Start with the highest-risk changed files or changes
2. When you find a high-confidence issue, IMMEDIATELY call report_issue with the issue details
3. Continue analyzing and report more issues as you find them
4. Do not wait for complete review coverage before reporting concrete findings
5. When done, output a brief summary of what you reviewed

**report_issue Parameters**:
- \`file\`: File path (string)
- \`line_start\`: Starting line number (number)
- \`line_end\`: Ending line number (number)
- \`severity\`: "critical" | "error" | "warning" | "suggestion"
- \`category\`: "security" | "logic" | "performance" | "style" | "maintainability"
- \`title\`: Short title in ${lang} (string)
- \`description\`: Detailed description in ${lang} (string)
- \`suggestion\`: Fix suggestion in ${lang} (optional string)
- \`code_snippet\`: Relevant code (optional string)
- \`confidence\`: 0.0-1.0 how confident you are (number)

**Example**:
When you find an SQL injection vulnerability, immediately call:
\`\`\`
report_issue({
  file: "src/api/users.ts",
  line_start: 42,
  line_end: 45,
  severity: "critical",
  category: "security",
  title: "SQL 注入漏洞",
  description: "用户输入直接拼接到 SQL 查询中，攻击者可以执行任意 SQL 语句...",
  suggestion: "使用参数化查询或 ORM 来防止 SQL 注入",
  code_snippet: "const query = \`SELECT * FROM users WHERE id = \${userId}\`",
  confidence: 0.95
})
\`\`\`

**IMPORTANT**:
- Report issues ONE BY ONE as you find them
- Don't wait until the end to report all issues
- Prefer early reporting of concrete, high-confidence findings over exhaustive exploration
- If turns are constrained, prioritize the most important 1-3 issues first
- The system will handle deduplication automatically
- Write all titles, descriptions, and suggestions in ${lang}
`;
}

/** @deprecated Use getReportIssueToolInstructions(language) instead */
export const REPORT_ISSUE_TOOL_INSTRUCTIONS = getReportIssueToolInstructions('zh');

/**
 * Build streaming system prompt for agents
 */
export function buildStreamingSystemPrompt(
  agentRole: string,
  language: 'en' | 'zh' = 'zh'
): string {
  const lang = getLangLabel(language);
  return `You are an expert code reviewer specializing in ${agentRole}.

Your task is to analyze code changes and report issues using the report_issue tool.

**CRITICAL REQUIREMENTS**:
1. **REPORT ISSUES IMMEDIATELY**: Use the report_issue tool as soon as you find an issue
2. **DO NOT OUTPUT JSON**: Report via tool calls, not JSON output
3. ONLY review changed code (lines marked with + or -)
4. All descriptions MUST be in ${lang}
5. Prefer early emission of concrete, high-confidence findings over exhaustive exploration
6. Partial but concrete findings are preferred over zero reported issues

## Tool Usage

You have access to these tools:
- **report_issue**: Report a discovered code issue (USE THIS FOR EACH ISSUE)
- **Read**: Read file contents for full context
- **Grep**: Search for patterns in codebase
- **Glob**: Find files matching a pattern

${getReportIssueToolInstructions(language)}

${DIFF_ANALYSIS_INSTRUCTIONS}

## Final Output

After reviewing all code and reporting issues via the tool, output a brief summary:

\`\`\`
## Review Summary

Reviewed X files, found Y issues:
- Critical: N
- Error: N
- Warning: N
- Suggestion: N

Key areas reviewed:
- ...
\`\`\`
`;
}

/**
 * Specialist-specific instructions for streaming mode
 */
export const SPECIALIST_INSTRUCTIONS: Record<string, string> = {
  'style-reviewer': `
## Style Review Guidelines

**DO check**:
- Misleading naming that can cause incorrect usage or maintenance mistakes
- Structural issues that make control flow or ownership materially harder to understand
- Inconsistencies that violate explicit project standards or weaken readability in changed code

**Do NOT report**:
- naming preferences when the existing name is understandable
- minor spelling issues that do not change meaning or behavior
- generic consistency cleanups without a concrete maintenance risk
- optional refactors that only make the code "nicer"

**DO NOT comment on**:
- Whether code has comments or not (comment presence/absence is a personal/team choice)
- Missing documentation or JSDoc (unless it's a public API that clearly needs it)
- Comment quality or style (unless comments are misleading or incorrect)
- Import organization or order

**Spelling check examples**:
- \`fucntion\` → \`function\`
- \`recieve\` → \`receive\`
- \`destory\` → \`destroy\`
- \`sucess\` → \`success\`
- \`respose\` → \`response\`

## Over-Engineering Detection (过度设计检测)

**IMPORTANT**: Identify cases of over-engineering only when there is clear maintenance cost.
Do NOT report naming preferences, minor spelling, or speculative cleanups as maintainability issues.

Signs of over-engineering:
1. **Unnecessary abstraction**: Wrappers or helpers used only once
2. **Premature generalization**: Designing for hypothetical future needs
3. **Pattern abuse**: Using Factory/Strategy/etc. where simple code suffices
4. **Excessive configuration**: Too many config options for simple functionality
5. **Unused interfaces**: Defining types/interfaces not actually used
6. **Complex solutions for simple problems**: 30 lines of abstraction replacing 3 lines of direct code

Report as: severity "warning" only when the abstraction already causes concrete maintenance risk.
If it is merely an optional simplification, do NOT report it.
`,
  'performance-reviewer': `
## Performance Review Guidelines

**DO check**:
- concrete runtime costs such as N+1 queries, repeated I/O in loops, unbounded work amplification, or obviously hot-path recomputation
- algorithmic or data-access patterns with a clear and explainable cost model
- performance regressions that are likely in normal production usage

**Do NOT report**:
- speculative best-practice suggestions without evidence of meaningful cost
- micro-optimizations with unclear user or system impact
- generic caching, batching, memoization, or lazy-loading advice when no bottleneck is demonstrated

**Reporting bar**:
- Report a performance issue only when you can explain the cost and why it matters
- If the change is merely a possible best-practice improvement, skip it instead of reporting it
- Use severity "warning" only for concrete, likely performance risks
`,
};

/**
 * Specialist-specific checklists for streaming mode
 */
export const STREAMING_CHECKLISTS: Record<
  string,
  Array<{ id: string; category: IssueCategory; question: string }>
> = {
  'security-reviewer': [
    { id: 'sec-chk-01', category: 'security', question: '是否存在注入漏洞（SQL、命令、XSS）？' },
    { id: 'sec-chk-02', category: 'security', question: '敏感数据是否正确加密/脱敏？' },
    { id: 'sec-chk-03', category: 'security', question: '认证和授权是否正确实现？' },
    { id: 'sec-chk-04', category: 'security', question: '是否有硬编码的密钥或凭证？' },
    { id: 'sec-chk-05', category: 'security', question: '输入验证是否充分？' },
  ],
  'logic-reviewer': [
    { id: 'log-chk-01', category: 'logic', question: '边界条件是否正确处理？' },
    { id: 'log-chk-02', category: 'logic', question: '错误处理是否完善？' },
    { id: 'log-chk-03', category: 'logic', question: '是否有潜在的空指针/未定义访问？' },
    { id: 'log-chk-04', category: 'logic', question: '并发/竞态条件是否安全？' },
    { id: 'log-chk-05', category: 'logic', question: '业务逻辑是否正确？' },
  ],
  'performance-reviewer': [
    { id: 'perf-chk-01', category: 'performance', question: '是否有 N+1 查询问题？' },
    { id: 'perf-chk-02', category: 'performance', question: '是否有不必要的循环或重复计算？' },
    { id: 'perf-chk-03', category: 'performance', question: '内存使用是否合理？' },
    { id: 'perf-chk-04', category: 'performance', question: '是否正确使用缓存？' },
    { id: 'perf-chk-05', category: 'performance', question: '算法复杂度是否合理？' },
  ],
  'style-reviewer': [
    { id: 'sty-chk-01', category: 'style', question: '命名是否清晰规范？是否存在拼写错误？' },
    { id: 'sty-chk-02', category: 'style', question: '代码结构是否清晰？' },
    { id: 'sty-chk-03', category: 'style', question: '是否遵循项目编码规范？' },
    { id: 'sty-chk-04', category: 'maintainability', question: '是否有重复代码可以提取？' },
    {
      id: 'sty-chk-05',
      category: 'maintainability',
      question: '是否存在过度设计（不必要的抽象、模式滥用、过早泛化）？',
    },
  ],
};

/**
 * Build streaming user prompt for specialist agent
 */
export function buildStreamingUserPrompt(
  agentType: string,
  params: {
    diff: string;
    intentSummary?: string;
    fileAnalyses?: string;
    dependencyContextText?: string;
    standardsText?: string;
    /** Custom project-specific rules for this agent */
    projectRules?: string;
    /** Deleted files context (only file paths, content removed) - only for logic-reviewer */
    deletedFilesContext?: string;
    /** PR business context (Jira integration) */
    prContext?: PRContext;
  }
): string {
  const sections: string[] = [];
  const contextMode = getPromptContextMode(agentType);

  sections.push(`# Code Review Task: ${agentType}\n`);

  // PR Business Context (Issue Tracker integration) - inject early where it helps
  const prIssues = params.prContext?.issues || params.prContext?.jiraIssues || [];
  const prDescription = params.prContext?.prDescription?.trim();
  if (params.prContext && (prIssues.length > 0 || prDescription) && contextMode.includePrContext) {
    sections.push(
      ...buildPrContextSection(params.prContext, {
        maxIssues: contextMode.prContextMaxIssues,
        includeKeyPoints: contextMode.includeKeyPointsInPrContext,
      })
    );
  }

  if (params.intentSummary) {
    sections.push('## PR Intent\n');
    sections.push(params.intentSummary);
    sections.push('');
  }

  if (params.standardsText) {
    sections.push(params.standardsText);
    sections.push('');
  }

  if (params.projectRules) {
    sections.push(
      contextMode.useConciseRules
        ? takeFirstNonEmptyLines(params.projectRules, 10)
        : params.projectRules
    );
    sections.push('');
  }

  if (params.deletedFilesContext && contextMode.includeDeletedFiles) {
    sections.push(params.deletedFilesContext);
    sections.push('');
  }

  if (params.fileAnalyses && contextMode.includeFileAnalyses) {
    const fileAnalysisCount = countFileAnalysisEntries(params.fileAnalyses);
    const shouldSkipFileAnalyses =
      contextMode.skipFileAnalysesWhenOverLimit &&
      typeof contextMode.maxFileAnalyses === 'number' &&
      fileAnalysisCount > contextMode.maxFileAnalyses;

    if (!shouldSkipFileAnalyses) {
      sections.push('## File Change Analysis\n');
      sections.push(
        typeof contextMode.maxFileAnalyses === 'number'
          ? takeFirstFileAnalysisEntries(params.fileAnalyses, contextMode.maxFileAnalyses)
          : params.fileAnalyses
      );
      sections.push('');
    }
  }

  if (params.dependencyContextText) {
    sections.push(params.dependencyContextText);
    sections.push('');
    sections.push(
      'Do not suggest APIs introduced after these versions. If a better fix requires a newer dependency version, state that an upgrade is required.'
    );
    sections.push(
      'Treat compatibility notes in the dependency context as authoritative. Do not report code that is valid for these grounded versions just because older framework conventions differed.'
    );
    sections.push('');
  }

  // Add specialist-specific instructions
  const specialistInstructions = SPECIALIST_INSTRUCTIONS[agentType];
  if (specialistInstructions) {
    sections.push(specialistInstructions);
    sections.push('');
  }

  // Add checklist
  const checklist = STREAMING_CHECKLISTS[agentType];
  if (checklist) {
    sections.push('## Review Checklist\n');
    sections.push('Consider these items during your review:\n');
    const checklistToRender = contextMode.conciseChecklist ? checklist.slice(0, 3) : checklist;
    for (const item of checklistToRender) {
      sections.push(`- ${item.question}`);
    }
    sections.push('');
  }

  sections.push('## Code Changes (Diff)\n');
  sections.push('Review the following changes and report issues using the report_issue tool:\n');
  sections.push('```diff');
  sections.push(params.diff);
  sections.push('```');

  sections.push('\n## Instructions\n');
  sections.push('1. Start with high-risk changed files or changes');
  sections.push('2. Report each high-confidence issue immediately with report_issue');
  sections.push('3. Continue expanding coverage if turns remain');
  sections.push('4. Output a brief summary when done');

  return sections.join('\n');
}
