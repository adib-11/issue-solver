export interface Clock {
  now(): number;
  /** Calls fn every ms milliseconds; returns a function that cancels it. */
  every(ms: number, fn: () => Promise<void> | void): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  every(ms, fn) {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
};
