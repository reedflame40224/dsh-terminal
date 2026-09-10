export function createResizeController({ term, propose, send, ready, delay = 100, narrowDelay = 150 }) {
  let dragging = false;
  let disposed = false;
  let timer;
  let narrowTimer;
  let revision = 0;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const cancelNarrow = () => { clearTimeout(narrowTimer); narrowTimer = undefined; revision++; };
  const flush = () => {
    cancel();
    if (disposed || dragging) return;
    const size = propose();
    if (!size) return;
    cancelNarrow();
    if (ready() && (size.cols < term.cols || (size.cols === term.cols && size.rows < term.rows))) {
      // Let ZLE erase its old multi-line prompt at the old buffer width first.
      send(size.cols, size.rows);
      const current = revision;
      narrowTimer = setTimeout(() => {
        const apply = () => {
          if (disposed || dragging || current !== revision) return;
          term.resize(size.cols, size.rows);
        };
        if (typeof term.write === 'function') term.write('', apply);
        else apply();
      }, narrowDelay);
      return;
    }
    if (term.cols !== size.cols || term.rows !== size.rows) term.resize(size.cols, size.rows);
    // Always synchronize the PTY, even if xterm already has the final size.
    if (ready()) send(size.cols, size.rows);
  };
  return {
    fit(immediate = false) {
      if (disposed || dragging) return;
      cancel();
      if (immediate) flush();
      else timer = setTimeout(flush, delay);
    },
    begin() { dragging = true; cancel(); cancelNarrow(); },
    end() { dragging = false; flush(); },
    dispose() { disposed = true; cancel(); cancelNarrow(); },
  };
}
