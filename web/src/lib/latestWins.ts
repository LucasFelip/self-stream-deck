/**
 * A sender that never has more than one request in flight: while one is on its way, newer values replace older ones and only the
 * last is sent next. For a slider that reports every pixel of a drag (volume, brightness): the PC gets the position the finger
 * reached, not a queue of the positions it passed through.
 */
export function createLatestWins<T>(send: (value: T) => Promise<unknown> | void, onError: (error: unknown) => void): (value: T) => void {
  let pending: { value: T } | null = null;
  let sending = false;

  async function flush(): Promise<void> {
    if (sending || !pending) return;
    sending = true;
    const { value } = pending;
    pending = null;
    try {
      await send(value);
    } catch (error) {
      onError(error);
    }
    sending = false;
    void flush();
  }

  return (value) => {
    pending = { value };
    void flush();
  };
}
