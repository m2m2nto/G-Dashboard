import { useState, useRef, useEffect } from 'react';

export default function SearchableSelect({ value, options, onSelect, placeholder, className }) {
  const [query, setQuery] = useState(value || '');
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    setQuery(value || '');
  }, [value]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filtered = (options || []).filter((opt) =>
    !query || opt.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="relative" ref={ref}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          className={`${className} pr-7`}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => {
            setIsOpen(!isOpen);
            inputRef.current?.focus();
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-on-surface-tertiary hover:text-on-surface focus:outline-none"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px', transition: 'transform 150ms', transform: isOpen ? 'rotate(180deg)' : '' }}>
            expand_more
          </span>
        </button>
      </div>
      {isOpen && filtered.length > 0 && (
        <ul className="absolute z-20 bg-white rounded-xl mt-1 max-h-48 overflow-y-auto w-full shadow-elevation-2">
          {filtered.map((opt) => (
            <li
              key={opt}
              onMouseDown={() => {
                setQuery(opt);
                onSelect(opt);
                setIsOpen(false);
              }}
              className={`px-3 py-2 text-sm cursor-pointer transition-colors ${
                opt === value ? 'bg-primary-light text-primary font-medium' : 'hover:bg-surface-dim text-on-surface'
              }`}
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
      {isOpen && filtered.length === 0 && query && (
        <div className="absolute z-20 bg-white rounded-xl mt-1 w-full shadow-elevation-2 px-3 py-3 text-sm text-on-surface-tertiary">
          No matches found
        </div>
      )}
    </div>
  );
}
