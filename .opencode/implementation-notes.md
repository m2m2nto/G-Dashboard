# Implementation Notes — Activity Filter UI Redesign

## Changed Files

| File | Change type | Summary |
|---|---|---|
| `client/src/App.jsx` | Modified | Replaced chips with Type dropdown, redesigned toolbar + filter rows to Entries pattern |
| `client/tests/activity-filters.test.js` | Modified | Updated filter function + tests for activityType string |

## Detailed Changes

### App.jsx

**State changes:**
- Replaced `activityFilters` (`useState([])`, array for multi-select chips) with `activityType` (`useState('')`, single-select string)
- Removed `ACTIVITY_FILTER_DEFS` module-level constant (no longer needed without chips)

**Filter pipeline:**
- Replaced chip OR-logic (`activeChipPredicates.some(p => p(e))`) with single prefix match: `if (activityType && !e.action?.startsWith(activityType + '.')) return false`
- Updated `useMemo` dependency array: `activityFilters` → `activityType`
- Updated `hasActiveFilters`: `activityFilters.length > 0` → `!!activityType`

**UI redesign (Entries pattern):**

Before:
```
[Toolbar: count + search pill + refresh button]
[Chip pills: Transactions | Cash Flow | Budget | Elements | More filters ▾ | Clear]
[Advanced filters (collapsible): stacked label-above-control layout]
```

After:
```
[Toolbar: count left | Refresh right, border-b]
[Primary filters (always visible): 🔍 Search | Type: dropdown | Action: dropdown | User: dropdown | Sort: dropdown | More/Fewer | Clear]
[Secondary filters (expandable): From: date | To: date | Year: dropdown | Month: dropdown | CF Cat: dropdown | Direction: dropdown | Min: input | Max: input | Scenario: dropdown]
```

All controls use `CONTROL_PADDED text-xs` with inline `label: control` pairs in `flex items-center gap-1.5` containers, matching `BudgetEntries.jsx` exactly.

**Clear handler:** Resets all 14 filter states + `activityShowAdvanced(false)` (per reviewer finding).

### activity-filters.test.js

- Replaced `activityFilters` array param with `activityType` string in `applyActivityFilters`
- Removed chip OR-logic from the filter function
- Updated 3 existing tests (chip → type, multi-select → single-select)
- Added 2 new tests: `cashflow` and `element` type prefix matching (per reviewer suggestion)

## Notes

- Multi-select type filtering (pick multiple categories at once) is no longer possible. This is an intentional simplification for UI consistency with the Entries page. The search field can still be used to narrow by action name if needed.
- `activityShowAdvanced` state is retained for the More/Fewer toggle but is now collapsed on Clear.
- Bundle size decreased slightly (788.99 kB vs 790.04 kB) due to removing chip rendering logic.
