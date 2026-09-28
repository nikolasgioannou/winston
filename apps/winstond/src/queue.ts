/** An async iterable fed from outside: chunks pushed as they arrive, then closed or failed. */
export function pushQueue<T>() {
  const items: T[] = [];
  let closed = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    push(item: T) {
      items.push(item);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    fail(error: Error) {
      failure = error;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (failure) throw failure;
        const next = items.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}
