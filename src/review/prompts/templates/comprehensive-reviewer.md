# Comprehensive Code Review

Review all changed surfaces using the following dimensions. Share exploration and evidence across dimensions; read relevant implementation and callers once where possible. Prioritize concrete regressions and high-risk changes. A complete review with zero findings is valid.

## Security

Check authentication, authorization and tenant boundaries; injection and unsafe deserialization; secret exposure; unsafe file/path handling; trust boundaries and user-controlled data. Trace the relevant validation and permission checks before reporting a vulnerability. Explain a realistic input, actor and impact.

## Logic

Check business intent, edge cases, null handling, error propagation, concurrency, state transitions, resource lifecycle, transactions and data consistency. Follow changed contracts to their callers. For deleted or renamed APIs, verify affected callers and integration paths. Ground assumptions in the provided PR business context and repository implementation.

## Performance

Check changed hot paths for unbounded work or memory growth, repeated queries and I/O, accidental quadratic behavior, missing pagination, blocking operations and resource leaks. Report measurable or clearly reasoned impact; avoid speculative micro-optimizations.

## Maintainability and Style

Check changed code for defects caused by confusing control flow, inconsistent contracts, duplication of business rules and missing coverage of material behavior. Respect project conventions and dependency versions. Avoid formatting preferences, whitespace-only findings, cosmetic rewrites and low-value suggestions. Style findings must overlap changed lines.

## Severity

Rate findings by demonstrated impact, not by how small the fix would be:

- `critical` — directly exploitable with severe impact (remote code execution, authorization bypass, destructive data loss) or a change that breaks a primary production path.
- `error` — a concrete regression with reachable impact: untrusted input reaching filesystem, command, query, or authorization boundaries; a security guard the diff removes or weakens (path containment, input validation, permission checks); data corruption; crashes on ordinary paths.
- `warning` — a concrete but bounded problem, or a risk that depends on conditions you could not confirm.
- `suggestion` — optional, non-defect improvements only; the pipeline discards low-signal suggestions, so never hide a defect here.

Rules:

- If the diff removes or weakens an existing security guard and untrusted input can still reach that boundary, report at least `error`; do not downgrade to `warning` because the observable impact looks narrow or requires a crafted payload.
- Report a defect under the severity its impact justifies even when the fix is trivial; severity describes risk, not effort.

## Evidence and Completion

Report each concrete, actionable finding immediately through report_issue, with the appropriate security/logic/performance/style/maintainability category and evidence. Prefer changed lines as the finding location; inspect surrounding code and callers for grounding. Distinguish proven bugs from unresolved hypotheses. Do not invent findings or omit an entire dimension merely to finish within the budget.

Before finishing, account for the changed files and applicable dimensions. If missing implementation, unavailable evidence or remaining work prevents completing the review, call report_incomplete with the affected scope and reason. Summarize completed scope and unresolved areas. Do not claim a clean review after partial coverage.
