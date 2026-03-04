export class RepoLockManager {
  private readonly tails = new Map<string, Promise<void>>();

  public async runExclusive<T>(repoId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(repoId) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.tails.set(repoId, previous.then(() => current));

    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(repoId) === current) {
        this.tails.delete(repoId);
      }
    }
  }
}