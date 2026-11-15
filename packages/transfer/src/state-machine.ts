import type { TransferState } from "./types.js";

const TRANSITIONS: Record<TransferState, readonly TransferState[]> = {
  idle: ["preparing", "waiting-peer", "failed", "cancelled"],
  preparing: [
    "waiting-peer",
    "awaiting-approval",
    "negotiating",
    "awaiting-accept",
    "failed",
    "cancelled",
  ],
  "waiting-peer": ["awaiting-approval", "negotiating", "awaiting-accept", "failed", "cancelled"],
  "awaiting-approval": ["negotiating", "awaiting-accept", "failed", "cancelled"],
  negotiating: ["awaiting-accept", "transferring", "failed", "cancelled"],
  "awaiting-accept": ["transferring", "cancelled", "failed"],
  transferring: ["verifying", "reconnecting", "completed", "failed", "cancelled"],
  reconnecting: ["transferring", "awaiting-accept", "failed", "cancelled"],
  verifying: ["completed", "failed", "cancelled"],
  completed: [],
  cancelled: [],
  failed: [],
};

export class TransferStateError extends Error {
  readonly from: TransferState;
  readonly to: TransferState;

  constructor(from: TransferState, to: TransferState) {
    super(`invalid transfer state transition: ${from} -> ${to}`);
    this.name = "TransferStateError";
    this.from = from;
    this.to = to;
  }
}

export class TransferStateMachine {
  #state: TransferState;

  constructor(initial: TransferState = "idle") {
    this.#state = initial;
  }

  get state(): TransferState {
    return this.#state;
  }

  isTerminal(): boolean {
    return this.#state === "completed" || this.#state === "cancelled" || this.#state === "failed";
  }

  canTransition(next: TransferState): boolean {
    return TRANSITIONS[this.#state].includes(next);
  }

  transition(next: TransferState): void {
    if (next === this.#state) return;
    if (!this.canTransition(next)) throw new TransferStateError(this.#state, next);
    this.#state = next;
  }
}

export function allowedTransitions(state: TransferState): readonly TransferState[] {
  return TRANSITIONS[state];
}
