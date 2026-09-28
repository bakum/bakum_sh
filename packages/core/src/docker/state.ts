/** Last known state of build containers by compose project (filled from docker events and polling). */
export interface ContainerState {
  id: string;
  name: string;
  state: string;
  health: string | null;
  buildId: number | null;
  projectId: string;
  branchId: number | null;
  labels: Record<string, string>;
}

export const containerStates = new Map<string, ContainerState>();

/** False until the first successful poll: before it, a missing entry means "unknown", not "container gone". */
export const containerPoll = { loaded: false };
