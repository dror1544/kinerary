export const tripStates = [
  "pending_signup_approval",
  "draft",
  "intake_in_progress",
  "intake_confirmed",
  "planned",
  "provisioning_approved",
  "provisioning",
  "ready_private",
  "activation_approved",
  "active",
  "completed",
  "sealed",
] as const;

export type TripState = typeof tripStates[number];

const allowedTransitions: Readonly<Record<TripState, readonly TripState[]>> = {
  pending_signup_approval: ["draft"],
  draft: ["intake_in_progress"],
  intake_in_progress: ["intake_confirmed"],
  intake_confirmed: ["planned"],
  planned: ["provisioning_approved"],
  provisioning_approved: ["provisioning"],
  provisioning: ["ready_private"],
  ready_private: ["activation_approved"],
  activation_approved: ["active"],
  active: ["completed"],
  completed: ["sealed"],
  sealed: [],
};

export function canTransitionTrip(from: TripState, to: TripState): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertTripTransition(from: TripState, to: TripState): void {
  if (!canTransitionTrip(from, to)) throw new Error(`invalid trip transition: ${from} -> ${to}`);
}

export const jobStates = ["queued", "leased", "running", "waiting", "succeeded", "failed", "cancelled"] as const;
export type JobState = typeof jobStates[number];
