// @ts-check

// Project selection is process-global. Ordinary API requests may overlap, but
// Project activation needs exclusive access until recovery and failure rollback
// have completed.
let activeReaders = 0;
let writerActive = false;
const waiters = [];

function drain() {
  if (writerActive || waiters.length === 0) return;
  if (waiters[0].exclusive) {
    if (activeReaders > 0) return;
    writerActive = true;
    const waiter = waiters.shift();
    waiter.resolve(() => {
      writerActive = false;
      drain();
    });
    return;
  }

  // Admit the contiguous reader group ahead of the next writer. New readers
  // queue behind a waiting writer, so Project activation cannot starve.
  while (waiters.length > 0 && !waiters[0].exclusive) {
    activeReaders++;
    const waiter = waiters.shift();
    waiter.resolve(() => {
      activeReaders--;
      drain();
    });
  }
}

/** @param {{ exclusive?: boolean }} [opts] @returns {Promise<() => void>} */
export function acquireProjectAccess({ exclusive = false } = {}) {
  return new Promise((resolve) => {
    waiters.push({ exclusive, resolve });
    drain();
  });
}
