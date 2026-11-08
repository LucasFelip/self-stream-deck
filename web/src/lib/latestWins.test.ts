import { describe, expect, it } from 'vitest';
import { createLatestWins } from './latestWins';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('createLatestWins', () => {
  it('sends the first value at once and, while it is in flight, only the last of the newer ones', async () => {
    const sent: number[] = [];
    const gates = [deferred(), deferred(), deferred()];
    let call = 0;
    const send = createLatestWins<number>((value) => { sent.push(value); return gates[call++]!.promise; }, () => undefined);

    send(1);
    send(2);
    send(3);
    send(4);
    expect(sent).toEqual([1]);
    gates[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([1, 4]);
    gates[1]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([1, 4]); // nothing newer was waiting
  });

  it('reports a failure and keeps going with the next value', async () => {
    const errors: unknown[] = [];
    const sent: number[] = [];
    const send = createLatestWins<number>((value) => {
      sent.push(value);
      if (value === 1) return Promise.reject(new Error('down'));
      return undefined;
    }, (error) => errors.push(error));
    send(1);
    send(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([1, 2]);
    expect(errors).toHaveLength(1);
  });
});
