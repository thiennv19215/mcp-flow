// Cross-engine execution lock (FEAT-11; study B6, feature #17 lock half).
//
// Logic (implemented fresh from the reference's design, not its code):
// single-image engines — Angles, Effects, and later transform-style
// tools — must never run over each other, because each one drives the
// same Flow composer. They share ONE lock with three rules:
//
//   - a single owner holds the lock at a time; acquiring while another
//     engine holds it is refused, and the refusal reports the current
//     owner plus `canStopCurrent` — the blocked engine is offered
//     "stop current" instead of failing silently;
//   - the same owner may re-acquire (re-entrant): the hold, including
//     its original start time, is left undisturbed;
//   - "stop current" is a REQUEST, not a seizure: a blocked engine calls
//     requestStop(), the running owner observes stopRequested() and
//     honors it by releasing; only the owner can release its own hold.
//
// The reference's server-side quota/token gate that also lives behind
// feature #17 stays blocked (FEAT-B7) and is deliberately not reproduced
// here — this is the local lock only. Pure and dependency-free: the
// clock is injectable for tests.

export class FlowExecutionLock {
  #owner = null;
  #since = 0;
  #stopRequest = null;
  #now;

  constructor({ now = () => Date.now() } = {}) {
    this.#now = typeof now === "function" ? now : () => Date.now();
  }

  acquire(owner) {
    const name = typeof owner === "string" ? owner.trim() : "";
    if (!name) throw new TypeError("FlowExecutionLock.acquire requires an owner name.");
    if (!this.#owner) {
      this.#owner = name;
      this.#since = this.#now();
      this.#stopRequest = null;
      return { ok: true, owner: name, reentrant: false, acquiredAt: this.#since };
    }
    if (this.#owner === name) {
      return { ok: true, owner: name, reentrant: true, acquiredAt: this.#since };
    }
    return { ok: false, owner: this.#owner, since: this.#since, canStopCurrent: true };
  }

  release(owner) {
    if (!this.#owner || this.#owner !== owner) return false;
    this.#owner = null;
    this.#since = 0;
    this.#stopRequest = null;
    return true;
  }

  requestStop(requestedBy) {
    const name = typeof requestedBy === "string" ? requestedBy.trim() : "";
    if (!this.#owner || !name || name === this.#owner) return { ok: false, owner: this.#owner };
    this.#stopRequest = { requestedBy: name, at: this.#now() };
    return { ok: true, owner: this.#owner };
  }

  stopRequested() {
    return this.#stopRequest ? { ...this.#stopRequest } : null;
  }

  current() {
    return this.#owner ? { owner: this.#owner, since: this.#since } : null;
  }

  isHeldBy(owner) {
    return Boolean(this.#owner) && this.#owner === owner;
  }
}
