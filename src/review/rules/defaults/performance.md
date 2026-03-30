# Performance Review Rules

> Default guidance for `performance-reviewer`.

## What To Report

- N+1 queries or repeated data fetches in loops
- Repeated I/O, network calls, or heavy computation on likely hot paths
- Unbounded work amplification caused by nested iteration or unnecessary full scans
- Missing batching or caching only when the current code already shows a meaningful cost
- Resource leaks or obviously wasteful work in normal production usage

## What Not To Report

- Speculative best-practice suggestions without bottleneck evidence
- Micro-optimizations with unclear user or system impact
- Generic advice to cache, batch, memoize, or lazy-load when no meaningful cost is shown
- Premature optimization where readability is the only tradeoff being made

## Severity Guidance

- `critical`: The change can plausibly cause service instability, OOM, or sustained outage-level load
- `error`: The change introduces a concrete and likely performance regression
- `warning`: There is real cost and likely impact, but not outage-level
- `suggestion`: Use rarely; if the finding is only a possible best-practice improvement, prefer not reporting it

## Examples

```typescript
// Bad: repeated I/O inside a loop
for (const userId of userIds) {
  const profile = await profileRepository.findByUserId(userId);
  profiles.push(profile);
}

// Better: batch the lookup when the repository supports it
const profiles = await profileRepository.findByUserIds(userIds);
```

```java
// Bad: nested scan amplifies work with data size
for (Order order : orders) {
    for (Item item : items) {
        if (item.getOrderId().equals(order.getId())) {
            order.addItem(item);
        }
    }
}
```
