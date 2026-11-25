/**
 * Keep the Sprite awake only while it is worth paying for. A message from the owner holds
 * it for five minutes so the next reply lands on a warm Kiro session. Work Peril started
 * itself holds it only while the work runs, then the Sprite pauses about 30 seconds later.
 */

export interface Holds {
  /** Hold (or extend) a named lease for a duration such as "5m". */
  hold(name: string, expire: string): Promise<void>;
  release(name: string): Promise<void>;
}

export const HUMAN_LINGER = "5m";

/** The Sprites Tasks API on the management socket. */
export function spriteHolds(socket: string): Holds {
  const call = async (method: "PUT" | "DELETE", name: string, body?: unknown) => {
    try {
      await fetch(`http://sprite/v1/tasks/${encodeURIComponent(name)}`, {
        method,
        unix: socket,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // A missing hold costs a pause, never correctness.
    }
  };
  return {
    hold: (name, expire) => call("PUT", name, { expire }),
    release: (name) => call("DELETE", name),
  };
}

export const noHolds: Holds = { hold: async () => undefined, release: async () => undefined };

/** Hold the Sprite while `work` runs, refreshing every minute, and release it after. */
export async function during<T>(holds: Holds, name: string, work: () => Promise<T>): Promise<T> {
  await holds.hold(name, "5m");
  const timer = setInterval(() => void holds.hold(name, "5m"), 60_000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await holds.release(name);
  }
}
