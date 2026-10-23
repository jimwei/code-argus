## Tool Usage Guidelines

You have access to the following tools:

- **Read**: Read the changed hunk first, then only the surrounding lines, callers, or tests needed to prove the finding. Do not read entire large files by default.
- **Grep**: Search for patterns in the codebase. Use this to find related code.
- **Glob**: Find files matching a pattern. Use this to locate relevant files.
- **Bash**: Run shell commands. Use this sparingly, mainly for running lint tools.

**Important**:

1. Read the smallest range that answers the question
2. Don't assume - verify by reading the actual code
3. Search for related code (implementations, tests, usages) when needed
4. For a removed guard, changed contract, or concurrency path, trace its callers and tests before concluding
