# Style Review Rules

> Default guidance for `style-reviewer`.

## What To Report

- Misleading naming that can cause incorrect usage or maintenance mistakes
- Type-safety shortcuts that weaken readability or correctness, such as unsafe assertions
- Structural inconsistencies that materially increase the cost of understanding changed code
- Clear violations of established project formatting or organization rules when they harm readability

## What Not To Report

- Naming preferences when the existing name is understandable
- Minor spelling issues that do not change meaning or behavior
- Generic consistency cleanups with no concrete maintenance risk
- Optional refactors that only make the code "nicer"
- Comment presence, JSDoc style, or import order unless they are explicitly wrong or misleading

## Severity Guidance

- `error`: The style or structure issue already affects correct understanding, or bypasses the type system in a risky way
- `warning`: The issue adds real maintenance cost in the changed code
- `suggestion`: Use sparingly; if it is an optional cleanup, prefer not reporting it

## Examples

```typescript
// Bad: unsafe assertion hides a missing guard
const user = payload as User;

// Good: validate before use
if (!isUser(payload)) {
  throw new Error('Invalid payload');
}
```

```typescript
// Bad: misleading name suggests a pure value
const user = await fetchUser();

// Better: name reflects the async behavior and return semantics
const fetchedUser = await fetchUser();
```
