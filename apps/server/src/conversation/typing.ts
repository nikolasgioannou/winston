type Schedule = (delay: number, run: () => void) => () => void;
const schedule: Schedule = (delay, run) => {
  const timer = setTimeout(run, delay);
  return () => {
    clearTimeout(timer);
  };
};

export function startTypingIndicator(options: {
  signal: AbortSignal;
  send: (signal: AbortSignal) => Promise<boolean>;
  schedule?: Schedule;
}) {
  const later = options.schedule ?? schedule;
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let cancelTick = () => {};
  let cancelDeadline = () => {};

  function stop() {
    cancelTick();
    cancelDeadline();
    options.signal.removeEventListener("abort", stop);
    controller.abort();
  }

  async function tick() {
    try {
      signal.throwIfAborted();
      if (!(await options.send(signal))) {
        stop();
        return;
      }
      signal.throwIfAborted();
      cancelTick = later(3500, () => {
        tick().catch(stop);
      });
    } catch {
      stop();
    }
  }

  if (!signal.aborted) {
    options.signal.addEventListener("abort", stop, { once: true });
    cancelTick = later(750, () => {
      tick().catch(stop);
    });
    cancelDeadline = later(60_000, stop);
  }
  return stop;
}
