// A tiny async lock: runs tasks one at a time, in order.
// Used so the background watch loop and demo buttons never poll the chain at once.

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
