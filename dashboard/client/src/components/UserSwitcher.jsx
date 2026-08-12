import { useState, useRef, useEffect } from 'react';

const AVATAR_COLORS = [
  'bg-primary text-white',
  'bg-amber-500 text-white',
  'bg-emerald-600 text-white',
  'bg-purple-600 text-white',
  'bg-rose-500 text-white',
  'bg-cyan-600 text-white',
  'bg-orange-500 text-white',
  'bg-indigo-500 text-white',
];

function getInitials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function getColor(name, index) {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

export default function UserSwitcher({ users, currentUser, onSwitch, onAdd }) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const ref = useRef(null);
  const inputRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Focus input when opening add mode
  useEffect(() => {
    if (adding && inputRef.current) inputRef.current.focus();
  }, [adding]);

  const handleAdd = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    await onAdd(trimmed);
    setNewName('');
    setAdding(false);
  };

  const currentIndex = currentUser ? users.indexOf(currentUser) : -1;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 h-9 px-2 rounded-full hover:bg-surface-dim transition-colors"
      >
        {currentUser ? (
          <>
            <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold ${getColor(currentUser, Math.max(currentIndex, 0))}`}>
              {getInitials(currentUser)}
            </span>
            <span className="text-sm font-medium text-on-surface">{currentUser}</span>
          </>
        ) : (
          <>
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-surface-dim text-on-surface-tertiary">
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>person</span>
            </span>
            <span className="text-sm text-on-surface-tertiary">No user</span>
          </>
        )}
        <span className="material-symbols-outlined text-on-surface-tertiary" style={{ fontSize: '16px' }}>
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 w-56 bg-white rounded-xl shadow-elevation-3 border border-surface-border py-1 z-50">
          {users.length > 0 && (
            <div className="py-1">
              {users.map((name, i) => (
                <button
                  key={name}
                  onClick={() => {
                    onSwitch(name);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                    name === currentUser
                      ? 'bg-primary-light text-primary'
                      : 'text-on-surface hover:bg-surface-container'
                  }`}
                >
                  <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold ${getColor(name, i)}`}>
                    {getInitials(name)}
                  </span>
                  <span className="font-medium">{name}</span>
                  {name === currentUser && (
                    <span className="material-symbols-outlined ml-auto" style={{ fontSize: '16px' }}>check</span>
                  )}
                </button>
              ))}
            </div>
          )}

          <div className="border-t border-surface-border px-3 py-2">
            {adding ? (
              <form
                onSubmit={(e) => { e.preventDefault(); handleAdd(); }}
                className="flex items-center gap-2"
              >
                <input
                  ref={inputRef}
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Name..."
                  className="flex-1 h-8 rounded-lg px-2.5 text-sm bg-surface-container border-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button
                  type="submit"
                  disabled={!newName.trim()}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-primary text-white disabled:opacity-40 hover:bg-primary-hover transition-colors"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>add</span>
                </button>
              </form>
            ) : (
              <button
                onClick={() => setAdding(true)}
                className="w-full flex items-center gap-2.5 py-1 text-sm text-on-surface-secondary hover:text-on-surface transition-colors"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>person_add</span>
                Add user
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
