/**
 * A BroadcastChannel that reaches only this test file's realm. Node's own
 * reaches every vitest thread in the process, so two suites on one channel
 * name would answer each other.
 */
export class LocalChannel {
  private static open = new Set<LocalChannel>();
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(readonly name: string) {
    LocalChannel.open.add(this);
  }
  postMessage(data: unknown): void {
    for (const c of LocalChannel.open) {
      if (c !== this && c.name === this.name) {
        queueMicrotask(() => c.onmessage?.({ data } as MessageEvent));
      }
    }
  }
  /** every channel of this realm closed: a fresh module's channel is the only one listening */
  static closeAll(): void {
    LocalChannel.open.clear();
  }
  close(): void {
    LocalChannel.open.delete(this);
  }
}
