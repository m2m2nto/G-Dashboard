# Plan: Activity Filter UI Redesign (Entries Pattern)

## Summary

Redesign the Activity section filter UI to match the Budget Entries page pattern: a clean toolbar with count/actions, followed by an always-visible inline filter row with `label: control` pairs using `CONTROL_PADDED text-xs`, and an expandable secondary row for less-used filters. This replaces the current pill-toggle chips and stacked label-above-control "advanced filters" panel.

## Changes

### State
- Replace `activityFilters` (array, multi-select chips) with `activityType` (string, single-select dropdown)
- Keep `activityShowAdvanced` for the More/Fewer toggle
- Remove `ACTIVITY_FILTER_DEFS` module constant

### Filter pipeline
- Replace chip OR-logic with single-type prefix match: `if (activityType && !e.action?.startsWith(activityType + '.')) return false`
- Update `hasActiveFilters` and `useMemo` dependency array

### UI Layout
1. **Toolbar** — `px-4 py-2 flex items-center justify-between border-b` with entry count left, Refresh button right
2. **Primary filter row** — always visible, `px-4 py-2 flex items-center gap-3 flex-wrap border-b`: Search (icon-in-input), Type, Action, User, Sort, More/Fewer toggle, Clear
3. **Secondary filter row** — expandable, same inline style: From, To, Year, Month, CF Category, Direction, Min, Max, Scenario

### Tests
- Update `applyActivityFilters` to use `activityType` string
- Replace chip tests with type filter tests (transaction, budget, cashflow, element)
- Update composition test

## Risks
- Multi-select (OR logic across types) is lost — now single-select. Acceptable trade-off for UI consistency.
- `activityShowAdvanced` kept for expandable row; Clear handler must reset it too.
