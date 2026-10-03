import { useEffect, useState } from 'react';
import { MantineProvider, localStorageColorSchemeManager } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { chromeCss, cssVariablesResolver, theme } from './theme';
import { EventsProvider } from './lib/events';
import { useBm } from './lib/query';
import { Shell } from './components/Shell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Welcome } from './pages/Welcome';
import { AddProject } from './pages/AddProject';
import { SettingsPage } from './pages/Settings';
import { StatusPage } from './pages/Status';
import { BranchesPage } from './pages/Branches';
import { BuildsPage } from './pages/Builds';
import { AuditPage } from './pages/Audit';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 2000 } },
});

const colorSchemeManager = localStorageColorSchemeManager({ key: 'bm-color-scheme' });
const CHROME_CSS = chromeCss();

export function App() {
  return (
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} defaultColorScheme="auto" colorSchemeManager={colorSchemeManager}>
      <style>{CHROME_CSS}</style>
      <Notifications position="bottom-right" limit={5} />
      <QueryClientProvider client={queryClient}>
        <EventsProvider>
          <HashRouter>
            <RouteMemory />
            <ErrorBoundary scope="root">
              <Routes>
                <Route path="/welcome" element={<Welcome />} />
                <Route element={<Shell />}>
                  <Route path="/" element={<Home />} />
                  <Route path="/projects/new" element={<AddProject />} />
                  <Route path="/projects/:pid/branches" element={<BranchesPage />} />
                  <Route path="/projects/:pid/branches/:bid" element={<BranchesPage />} />
                  <Route path="/projects/:pid/branches/:bid/:tab" element={<BranchesPage />} />
                  <Route path="/projects/:pid/builds" element={<BuildsPage />} />
                  <Route path="/projects/:pid/audit" element={<AuditPage />} />
                  <Route path="/projects/:pid/settings" element={<SettingsPage />} />
                  <Route path="/projects/:pid/settings/:tab" element={<SettingsPage />} />
                  <Route path="/settings/app" element={<SettingsPage />} />
                  <Route path="/status" element={<StatusPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </ErrorBoundary>
          </HashRouter>
        </EventsProvider>
      </QueryClientProvider>
    </MantineProvider>
  );
}

const LAST_ROUTE = 'bm.lastRoute';

/** Remembers the last project/branch route and follows navigation requests from main (tray, notifications). */
function RouteMemory() {
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    if (loc.pathname.startsWith('/projects/') && !loc.pathname.startsWith('/projects/new')) {
      try {
        localStorage.setItem(LAST_ROUTE, loc.pathname);
      } catch {
        /* storage unavailable */
      }
    }
  }, [loc.pathname]);
  useEffect(() => window.bm.desktop.onNavigate((r) => nav(r)), [nav]);
  return null;
}

function Home() {
  const state = useBm('system.state', {});
  const projects = useBm('projects.list', {});
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!state.data || !projects.data) return;
    if (state.data.firstRun) return setTarget('/welcome');
    if (!projects.data.length) return setTarget('/projects/new');
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_ROUTE);
    } catch {
      last = null;
    }
    const pid = last?.split('/')[2];
    if (last && projects.data.some((p) => p.id === pid)) return setTarget(last);
    setTarget(`/projects/${projects.data[0]!.id}/branches`);
  }, [state.data, projects.data]);
  return target ? <Navigate to={target} replace /> : null;
}
