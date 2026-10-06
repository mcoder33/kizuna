// Resize callbacks run before paint. Defer layout writes to the next frame so
// changing an observed ancestor cannot restart the same delivery cycle.
export function frameResizeObserver(callback) {
  let frame = null;
  const observer = new ResizeObserver(() => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      callback();
    });
  });
  return {
    observe: (...args) => observer.observe(...args),
    disconnect() {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
