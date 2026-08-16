export const SEARCH_INPUT_WRAPPER = 'relative';

export const SEARCH_INPUT =
  'w-full h-9 pl-9 pr-3 text-sm bg-surface-container rounded-full border-none focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-on-surface-tertiary';

export const SEARCH_INPUT_COMPACT =
  'w-full h-9 pl-9 pr-3 text-sm bg-surface-container rounded-full border-none focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-on-surface-tertiary';

export default function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
  className = '',
  inputClassName = SEARCH_INPUT,
  size = 'default',
}) {
  const iconSize = '18px';

  return (
    <div className={`relative ${className}`}>
      <span
        className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-tertiary pointer-events-none"
        style={{ fontSize: iconSize }}
      >
        search
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputClassName}
      />
    </div>
  );
}
