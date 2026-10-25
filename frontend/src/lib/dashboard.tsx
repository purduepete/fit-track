import { createContext, useContext, type ReactNode } from 'react';
import { api, type DashboardSummary } from './api';
import { useApiResource } from './useApiResource';

type DashboardResource = ReturnType<typeof useApiResource<DashboardSummary>>;
const DashboardContext = createContext<DashboardResource | null>(null);

export function DashboardProvider({ children, onAuthError }: { children: ReactNode; onAuthError: () => void }) {
    const resource = useApiResource(() => api.dashboard(), [onAuthError], onAuthError);
    return <DashboardContext.Provider value={resource}>{children}</DashboardContext.Provider>;
}

export function useDashboard() {
    const resource = useContext(DashboardContext);
    if (!resource) throw new Error('useDashboard must be used within a DashboardProvider');
    return resource;
}
