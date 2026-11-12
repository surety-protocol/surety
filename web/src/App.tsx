import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Overview } from './pages/Overview';
import { Agents } from './pages/Agents';
import { AgentDetail } from './pages/AgentDetail';
import { Jobs } from './pages/Jobs';
import { JobDetail } from './pages/JobDetail';
import { Simulation } from './pages/Simulation';
import { TryIt } from './pages/TryIt';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="agents" element={<Agents />} />
          <Route path="agents/:id" element={<AgentDetail />} />
          <Route path="jobs" element={<Jobs />} />
          <Route path="jobs/:id" element={<JobDetail />} />
          <Route path="simulation" element={<Simulation />} />
          <Route path="try" element={<TryIt />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
