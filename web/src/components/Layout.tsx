import { NavLink, Outlet } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  LayoutDashboard, Users, Briefcase, BarChart2,
  PlayCircle, Shield, ExternalLink, ChevronRight
} from 'lucide-react';

const NAV = [
  { to: '/',           label: 'Overview',   Icon: LayoutDashboard, end: true },
  { to: '/agents',     label: 'Agents',     Icon: Users,           end: false },
  { to: '/jobs',       label: 'Jobs',       Icon: Briefcase,       end: false },
  { to: '/simulation', label: 'Simulation', Icon: BarChart2,       end: false },
  { to: '/try',        label: 'Try It',     Icon: PlayCircle,      end: false },
];

const isMock = import.meta.env.VITE_USE_MOCK !== 'false';

export function Layout() {
  return (
    <div className="flex h-full min-h-screen">
      {/* ── Sidebar ─────────────────────────────────────────────────── */}
      <aside
        style={{ backgroundColor: '#0f1117', borderRight: '1px solid #1e2333' }}
        className="hidden lg:flex flex-col w-60 shrink-0 fixed inset-y-0 left-0 z-50"
      >
        {/* Logo */}
        <div style={{ borderBottom: '1px solid #1e2333' }} className="flex items-center gap-3 px-5 h-16">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 shrink-0">
            <Shield className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-white tracking-tight leading-none">Surety</p>
            <p className="text-[11px] text-slate-500 mt-0.5">NEAR Testnet</p>
          </div>
          {isMock && (
            <span className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
              mock
            </span>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5" aria-label="Main navigation">
          <p className="px-2 mb-2 text-[10px] font-semibold tracking-widest text-slate-600 uppercase">
            Dashboard
          </p>
          {NAV.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                clsx(
                  'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150',
                  isActive
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className={clsx('h-4 w-4 shrink-0', isActive ? 'text-white' : 'text-slate-500 group-hover:text-slate-300')} />
                  <span>{label}</span>
                  {isActive && <ChevronRight className="ml-auto h-3 w-3 text-blue-200" />}
                </>
              )}
            </NavLink>
          ))}

          <div style={{ borderTop: '1px solid #1e2333' }} className="mt-4 pt-4">
            <p className="px-2 mb-2 text-[10px] font-semibold tracking-widest text-slate-600 uppercase">
              Resources
            </p>
            <a
              href="https://explorer.testnet.near.org"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-colors"
            >
              <ExternalLink className="h-4 w-4 shrink-0" />
              Explorer
              <ExternalLink className="ml-auto h-3 w-3 opacity-50" />
            </a>
          </div>
        </nav>

        {/* Footer */}
        <div style={{ borderTop: '1px solid #1e2333' }} className="px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
            <span className="text-xs text-slate-500">surety.testnet</span>
          </div>
          <p className="mt-1 text-[10px] text-slate-600">NEAR Hackathon 2026</p>
        </div>
      </aside>

      {/* ── Mobile top bar ──────────────────────────────────────────── */}
      <header
        style={{ borderBottom: '1px solid #1e2333', backgroundColor: '#0f1117' }}
        className="lg:hidden fixed top-0 inset-x-0 z-50 flex h-14 items-center px-4 gap-4"
      >
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600">
            <Shield className="h-4 w-4 text-white" />
          </div>
          <span className="text-sm font-bold text-white">Surety</span>
        </div>
        <nav className="flex items-center gap-0.5 overflow-x-auto" aria-label="Mobile navigation">
          {NAV.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                clsx(
                  'px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors',
                  isActive ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white hover:bg-white/10'
                )
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        {isMock && (
          <span className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
            mock
          </span>
        )}
      </header>

      {/* ── Main content ────────────────────────────────────────────── */}
      <div className="flex-1 lg:pl-60 flex flex-col min-h-screen">
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-8 mt-14 lg:mt-0">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>

        <footer style={{ borderTop: '1px solid #e2e8f0' }} className="px-8 py-4 text-xs text-slate-400 flex items-center justify-between">
          <span>Surety · NEAR Hackathon 2026 · MIT</span>
          <span className="flex items-center gap-1">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
            Testnet live
          </span>
        </footer>
      </div>
    </div>
  );
}
