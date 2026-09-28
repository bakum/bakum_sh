import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CoreEvent } from '@bm/shared';

const PREFIXES: Record<CoreEvent['type'], string[]> = {
  'project.changed': ['projects.', 'branches.', 'system.', 'config.'],
  'branch.changed': ['branches.', 'builds.', 'config.effective', 'jobs.'],
  'build.changed': ['builds.', 'branches.', 'jobs.', 'logs.'],
  'job.changed': ['jobs.', 'builds.', 'branches.'],
  'system.changed': ['system.'],
  'config.changed': ['config.', 'projects.', 'branches.'],
  notification: [],
};

type Listener = (e: CoreEvent) => void;
const Ctx = createContext<{ listen: (l: Listener) => () => void; coreRestartedAt: string | null }>({
  listen: () => () => {},
  coreRestartedAt: null,
});

/** Subscribes once to Core `events` and invalidates the affected queries. */
export function EventsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const listeners = useRef(new Set<Listener>());
  const [coreRestartedAt, setRestarted] = useState<string | null>(null);
  useEffect(() => {
    const unsub = window.bm.subscribe('events', {}, (data) => {
      const batch = data as CoreEvent[];
      const prefixes = new Set(batch.flatMap((e) => PREFIXES[e.type] ?? []));
      if (prefixes.size) {
        void qc.invalidateQueries({ predicate: (q) => [...prefixes].some((p) => String(q.queryKey[0]).startsWith(p)) });
      }
      for (const e of batch) for (const l of listeners.current) l(e);
    });
    const unStatus = window.bm.onCoreStatus((s) => {
      if (s.state === 'restarted') setRestarted(s.at);
      if (s.state === 'connected') void qc.invalidateQueries();
    });
    return () => {
      unsub();
      unStatus();
    };
  }, [qc]);
  return (
    <Ctx.Provider value={{ listen: (l) => (listeners.current.add(l), () => listeners.current.delete(l)), coreRestartedAt }}>
      {children}
    </Ctx.Provider>
  );
}

export const useCoreEvents = () => useContext(Ctx);
