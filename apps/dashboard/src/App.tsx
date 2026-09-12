import { useState, useEffect, useCallback } from 'react';
import { Ticket } from './types.js';
import {
  fetchTickets,
  approveTicket,
  rejectTicket,
  triggerScan,
  fetchProjects,
  createProject,
  fetchQuickDirs,
  browseDirectory,
  pickNativeFolder,
  ProjectItem,
  QuickDir,
  BrowseResult
} from './api.js';
import { CouncilDisputeModal } from './components/CouncilDisputeModal.js';
import { TicketTable } from './components/TicketTable.js';

// The 6 kanban columns requested by Prompt 6.1
const KANBAN_COLUMNS: { id: string; title: string; badgeColor: string }[] = [
  { id: 'found', title: 'Found', badgeColor: 'bg-yellow-600' },
  { id: 'triaged', title: 'Triaged', badgeColor: 'bg-blue-500' },
  { id: 'approved', title: 'Approved', badgeColor: 'bg-green-600' },
  { id: 'in_review', title: 'In Review', badgeColor: 'bg-violet-500' },
  { id: 'awaiting_human', title: 'Awaiting Human', badgeColor: 'bg-orange-500' },
  { id: 'pushed', title: 'Pushed', badgeColor: 'bg-slate-400' }
];

export interface ScanProgressState {
  stage: string;
  current: number;
  total: number;
  currentFile?: string;
  message: string;
  percent: number;
}

export function App() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [projectId, setProjectId] = useState<string>(() => {
    return localStorage.getItem('ai_dev_team_project_id') || '';
  });
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgressState | null>(null);

  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [disputeModalTicket, setDisputeModalTicket] = useState<Ticket | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeTab, setActiveTab] = useState<string>('all');


  // New project modal state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);
  const [newProjectName, setNewProjectName] = useState<string>('');
  const [newProjectPath, setNewProjectPath] = useState<string>('');
  const [newProjectGithub, setNewProjectGithub] = useState<string>('');
  const [isCreatingProject, setIsCreatingProject] = useState<boolean>(false);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);

  // Directory browser state
  const [quickDirs, setQuickDirs] = useState<QuickDir[]>([]);
  const [browseResult, setBrowseResult] = useState<BrowseResult | null>(null);
  const [isBrowsing, setIsBrowsing] = useState<boolean>(false);
  const [isPickingNative, setIsPickingNative] = useState<boolean>(false);

  const handleBrowseTo = async (dirPath: string) => {
    setIsBrowsing(true);
    try {
      const res = await browseDirectory(dirPath);
      setBrowseResult(res);
      setNewProjectPath(res.currentPath);
      if (!newProjectName.trim()) {
        const parts = res.currentPath.split('/').filter(Boolean);
        if (parts.length > 0) {
          setNewProjectName(parts[parts.length - 1]);
        }
      }
    } catch (err: any) {
      console.warn('Browse error:', err);
    } finally {
      setIsBrowsing(false);
    }
  };

  const handleNativePick = async () => {
    setIsPickingNative(true);
    try {
      const res = await pickNativeFolder();
      if (res && res.path && !res.cancelled) {
        handleBrowseTo(res.path);
      }
    } catch (err: any) {
      console.warn('Native picker error:', err);
    } finally {
      setIsPickingNative(false);
    }
  };

  // Load quick dirs when modal opens
  useEffect(() => {
    if (isCreateModalOpen) {
      fetchQuickDirs()
        .then((dirs) => {
          setQuickDirs(dirs);
          const initial = newProjectPath || (dirs.length > 0 ? dirs[0].path : undefined);
          if (initial) {
            handleBrowseTo(initial);
          }
        })
        .catch(() => {});
    }
  }, [isCreateModalOpen]);

  // Load projects list on mount
  useEffect(() => {
    fetchProjects()
      .then((data) => {
        setProjects(data);
        if (data.length > 0) {
          const stored = localStorage.getItem('ai_dev_team_project_id');
          const validStored = data.find(p => p.id === stored);
          const chosen = validStored ? validStored.id : data[0].id;
          setProjectId(chosen);
          localStorage.setItem('ai_dev_team_project_id', chosen);
        }
      })
      .catch((err) => console.warn('Could not fetch projects list:', err));
  }, []);


  const activeProject = projects.find((p) => p.id === projectId);

  const loadTickets = useCallback(async (silent = false) => {
    if (!projectId) return;
    if (!silent) setIsLoading(true);
    try {
      const data = await fetchTickets(projectId);
      setTickets(data);
      setLastUpdated(new Date());
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch tickets');
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [projectId]);

  // Initial fetch and WebSocket live updates (Prompt 10.1)
  useEffect(() => {
    if (!projectId) return;

    loadTickets();

    const host = typeof window !== 'undefined' ? (window.location.hostname || 'localhost') : 'localhost';
    const wsUrl = `ws://${host}:3000/ws/projects/${projectId}`;
    let socket: WebSocket | null = null;
    let reconnectTimeout: any = null;
    let isCancelled = false;

    function connect() {
      if (isCancelled) return;
      try {
        socket = new WebSocket(wsUrl);

        socket.onopen = () => {
          setWsConnected(true);
          setError(null);
        };

        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'scan_progress') {
              const details = message.details || message;
              let percent = 5;
              if (details.stage === 'starting') percent = 3;
              else if (details.stage === 'graph') percent = 8;
              else if (details.stage === 'impacted') percent = 15;
              else if (details.stage === 'scanning' || details.stage === 'static_analysis' || details.stage === 'llm_analysis') {
                const fraction = (details.current || 1) / Math.max(details.total || 1, 1);
                percent = Math.min(90, Math.round(15 + fraction * 75));
              } else if (details.stage === 'triage') {
                percent = 95;
              } else if (details.stage === 'completed') {
                percent = 100;
              }

              setIsScanning(details.stage !== 'completed' && details.stage !== 'error');
              setScanProgress({
                stage: details.stage,
                current: details.current || 0,
                total: details.total || 1,
                currentFile: details.currentFile,
                message: details.message || 'Scanning project...',
                percent
              });

              if (details.stage === 'completed') {
                loadTickets(true);
                setTimeout(() => setScanProgress(null), 10000);
              } else if (details.stage === 'error') {
                setIsScanning(false);
              }
            } else if (
              message.type === 'TICKET_TRANSITION' ||
              message.type === 'TICKET_CREATED' ||
              message.type === 'SCAN_COMPLETED' ||
              message.type === 'ticket_updated' ||
              message.type === 'ticket_created'
            ) {
              loadTickets(true);
            }
          } catch {
            // ignore non-json
          }
        };


        socket.onclose = () => {
          setWsConnected(false);
          if (!isCancelled) {
            reconnectTimeout = setTimeout(connect, 3000);
          }
        };

        socket.onerror = () => {
          setWsConnected(false);
        };
      } catch (err) {
        setWsConnected(false);
        if (!isCancelled) {
          reconnectTimeout = setTimeout(connect, 3000);
        }
      }
    }

    connect();

    return () => {
      isCancelled = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (socket) {
        try {
          socket.close();
        } catch {}
      }
    };
  }, [projectId, loadTickets]);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) {
      setCreateProjectError('Project name is required');
      return;
    }
    setIsCreatingProject(true);
    setCreateProjectError(null);
    try {
      const created = await createProject({
        name: newProjectName.trim(),
        localPath: newProjectPath.trim() || undefined,
        githubRepo: newProjectGithub.trim() || undefined,
      });
      const updatedList = await fetchProjects();
      setProjects(updatedList);
      setProjectId(created.id);
      localStorage.setItem('ai_dev_team_project_id', created.id);
      setIsCreateModalOpen(false);
      setNewProjectName('');
      setNewProjectPath('');
      setNewProjectGithub('');
    } catch (err: any) {
      setCreateProjectError(err.message || 'Failed to create project');
    } finally {
      setIsCreatingProject(false);
    }
  };

  const handleApprove = async (ticketId: string) => {
    await approveTicket(ticketId);
    await loadTickets(true);
  };

  const handleReject = async (ticketId: string) => {
    await rejectTicket(ticketId);
    await loadTickets(true);
  };

  const handleTriggerScan = async () => {
    setIsScanning(true);
    setScanMessage(null);
    setScanProgress({
      stage: 'starting',
      current: 0,
      total: 100,
      message: 'Dispatching scan job to background agent squad...',
      percent: 3
    });
    try {
      const res = await triggerScan(projectId);
      setScanMessage(`Scan job queued (${res.jobId})`);
      setTimeout(() => setScanMessage(null), 4000);
      await loadTickets(true);
    } catch (err: any) {
      setScanMessage(`Scan error: ${err.message}`);
      setScanProgress(null);
      setIsScanning(false);
    }
  };


  // Filter tickets by severity, search query, and active tab
  const filteredTickets = tickets.filter((t) => {
    if (severityFilter !== 'all' && t.severity !== severityFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = t.title.toLowerCase().includes(q);
      const matchDesc = t.description?.toLowerCase().includes(q);
      const matchFile = t.symptomFile?.path.toLowerCase().includes(q);
      const matchModel = t.scannerModel.toLowerCase().includes(q);
      const matchId = t.id.toLowerCase().includes(q);
      if (!matchTitle && !matchDesc && !matchFile && !matchModel && !matchId) {
        return false;
      }
    }
    if (activeTab === 'all') return true;
    if (activeTab === 'pipeline') return t.status === 'approved' || t.status === 'in_review';
    if (activeTab === 'disputed') return t.status === 'awaiting_human_dispute';
    // Direct status match for stat card filtering
    return t.status === activeTab;
  });

  const disputedTickets = tickets.filter((t) => t.status === 'awaiting_human_dispute');


  return (
    <div className="min-h-screen bg-[#111318] text-slate-200 flex flex-col font-sans w-full">
      {/* Top Enterprise Command Navbar */}
      <header className="border-b border-slate-700/50 bg-[#1a1d24] px-5 py-2.5 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-30">
        {/* Left: Brand & Active Project */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center font-black text-white text-xs">
              AI
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-bold text-slate-100 tracking-tight flex items-center gap-1.5">
                  Autonomous Dev Squad
                </h1>
                <span className="text-[10px] font-mono uppercase bg-slate-700/60 text-slate-300 border border-slate-600/40 px-1.5 py-0.2 rounded font-semibold">
                  Enterprise
                </span>
              </div>
              <p className="text-[11px] text-slate-400 truncate max-w-sm">
                {activeProject?.localPath ? (
                  <span className="flex items-center gap-1 font-mono text-[10px] text-slate-300 truncate" title={activeProject.localPath}>
                    <span>📂</span>
                    <span className="truncate">{activeProject.localPath}</span>
                  </span>
                ) : (
                  'Autonomous multi-model fleet'
                )}
              </p>
            </div>
          </div>

          {/* Project Selector */}
          {projects.length > 0 && (
            <div className="hidden md:flex items-center gap-2 pl-3 border-l border-slate-800">
              <span className="text-xs text-slate-400 font-medium">Project:</span>
              <select
                value={projectId}
                onChange={(e) => {
                  const id = e.target.value;
                  setProjectId(id);
                  localStorage.setItem('ai_dev_team_project_id', id);
                }}
                className="bg-[#1e2128] border border-slate-600/50 hover:border-slate-500 rounded-lg px-2.5 py-1 text-slate-200 text-xs focus:outline-none focus:border-blue-500 cursor-pointer max-w-[200px] font-medium truncate"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p._count?.tickets ?? 0} tickets)
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Center: Real-time Ticket Search Filter */}
        <div className="flex-1 max-w-md mx-2">
          <div className="relative">
            <span className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-slate-500 text-xs">
              🔍
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tickets, files, root causes, models..."
              className="w-full bg-[#1e2128] border border-slate-600/50 focus:border-blue-500 rounded-lg pl-8 pr-7 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none transition"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-slate-400 hover:text-white text-xs cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Right: Quick Actions */}
        <div className="flex items-center gap-2.5">
          {/* Severity Filter */}
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className="hidden lg:inline text-[11px]">Severity:</span>
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="bg-[#1e2128] border border-slate-600/50 hover:border-slate-500 rounded-lg px-2 py-1 text-slate-200 text-xs focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>

          {/* Add Project Button */}
          <button
            type="button"
            onClick={() => setIsCreateModalOpen(true)}
            className="bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700/80 text-xs px-2.5 py-1 rounded-lg font-medium flex items-center gap-1.5 transition cursor-pointer shadow-sm"
          >
            <span>+</span>
            <span className="hidden sm:inline">Add Project</span>
          </button>

          {/* Scan Codebase Primary Action */}
          <button
            onClick={handleTriggerScan}
            disabled={isScanning}
            className={`text-xs px-3.5 py-1 rounded-lg font-semibold transition flex items-center gap-1.5 cursor-pointer ${
              isScanning
                ? 'bg-slate-700 text-slate-400 cursor-not-allowed border border-slate-600'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
            }`}
          >
            {isScanning ? (
              <>
                <div className="w-3 h-3 border-2 border-slate-300 border-t-transparent rounded-full animate-spin" />
                <span>Scanning...</span>
              </>
            ) : (
              <>
                <span>⚡</span>
                <span>Scan Codebase</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Sub-header: Compact Control Bar */}
      <div className="bg-[#15181f] border-b border-slate-700/40 px-5 py-2 flex items-center justify-between gap-3 text-xs">
        {/* Left: Active filter label + Clear */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('all')}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition cursor-pointer border ${
              activeTab === 'all'
                ? 'bg-blue-600/20 text-blue-300 border-blue-500/40'
                : 'bg-slate-800/40 text-slate-400 border-slate-700/50 hover:text-slate-200'
            }`}
          >
            All Tickets
            <span className="ml-1 font-mono bg-slate-800/80 px-1.5 py-0.2 rounded text-[10px]">{tickets.length}</span>
          </button>
          {activeTab !== 'all' && (
            <span className="text-slate-500 text-[11px]">
              → Filtered by <strong className="text-blue-400 capitalize">{activeTab.replace('_', ' ')}</strong>
            </span>
          )}
        </div>

        {/* Right: Live sync & scan notice */}
        <div className="flex items-center gap-3 text-[11px]">
          {scanMessage && (
            <span className="text-green-400 bg-green-900/30 border border-green-700/40 px-2 py-0.5 rounded text-[11px] font-medium">
              {scanMessage}
            </span>
          )}
          <span className="flex items-center gap-1.5 text-slate-400">
            <span
              className={`w-2 h-2 rounded-full ${
                wsConnected ? 'bg-green-500' : 'bg-yellow-500'
              }`}
            />
            <span>{wsConnected ? 'Live' : 'Polling'}</span>
          </span>
          <span className="text-slate-500 font-mono hidden md:inline">
            {lastUpdated ? lastUpdated.toLocaleTimeString() : 'Connecting...'}
          </span>
        </div>
      </div>

      {/* Real-time Scan Progress Bar */}
      {scanProgress && (
        <div className="bg-[#15181f] border-b border-slate-700/40 px-5 py-2.5 transition-all duration-300">
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs mb-1.5">
            <div className="flex items-center gap-2.5">
              <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0"></span>
              <span className="font-semibold text-blue-400 uppercase tracking-wider text-[10px] bg-blue-900/20 border border-blue-700/30 px-2 py-0.5 rounded">
                {scanProgress.stage.replace('_', ' ')}
              </span>
              <span className="text-slate-300 text-xs font-medium">{scanProgress.message}</span>
            </div>

            <div className="flex items-center gap-3">
              {scanProgress.currentFile && (
                <div className="flex items-center gap-1.5 text-slate-400 bg-slate-700/30 border border-slate-600/30 px-2 py-0.5 rounded text-[11px] font-mono max-w-sm truncate">
                  <span>📄</span>
                  <span className="truncate">{scanProgress.currentFile}</span>
                </div>
              )}
              {scanProgress.total > 1 && scanProgress.stage !== 'completed' && (
                <span className="text-slate-400 text-xs font-mono">
                  {scanProgress.current} / {scanProgress.total}
                </span>
              )}
              <span className="font-mono text-xs font-semibold text-blue-400 min-w-10 text-right">
                {scanProgress.percent}%
              </span>
              {scanProgress.stage === 'completed' && (
                <button
                  onClick={() => setScanProgress(null)}
                  className="text-slate-400 hover:text-white text-xs cursor-pointer ml-1"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${
                scanProgress.stage === 'completed'
                  ? 'bg-green-600'
                  : scanProgress.stage === 'error'
                  ? 'bg-red-600'
                  : 'bg-blue-500'
              }`}
              style={{ width: `${Math.max(4, scanProgress.percent)}%` }}
            />
          </div>
        </div>
      )}

      {/* Main Full-Width Content */}
      <main className="flex-1 px-5 py-4 flex flex-col w-full overflow-hidden gap-3.5">
        {error && (
          <div className="bg-red-900/20 border border-red-700/40 text-red-300 text-xs rounded-lg p-3 flex items-center justify-between shrink-0">
            <span>{error}</span>
            <button
              onClick={() => loadTickets(false)}
              className="text-rose-200 underline hover:text-white"
            >
              Retry
            </button>
          </div>
        )}

        {/* ── Pipeline Stage Overview Cards ─────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2.5 shrink-0">
          {KANBAN_COLUMNS.map((col) => {
            const count = tickets.filter((t) => t.status === col.id).length;
            const isActive = activeTab === 'all' || (activeTab === col.id);
            return (
              <button
                key={col.id}
                onClick={() => setActiveTab(activeTab === col.id ? 'all' : col.id as any)}
                className={`group relative flex flex-col items-start gap-1 p-3 rounded-lg border transition-all cursor-pointer text-left ${
                  isActive && activeTab !== 'all'
                    ? 'bg-blue-600/10 border-blue-500/30'
                    : 'bg-[#1a1d24] border-slate-700/40 hover:border-slate-600/60 hover:bg-[#1e2128]'
                }`}
              >
                <div className="flex items-center gap-1.5 w-full">
                  <span className={`w-1.5 h-1.5 rounded-full ${col.badgeColor} shrink-0`} />
                  <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider truncate">
                    {col.title}
                  </span>
                </div>
                <span className={`text-xl font-bold font-mono ${count > 0 ? 'text-slate-100' : 'text-slate-600'}`}>
                  {count}
                </span>
                {/* Active indicator bar */}
                {isActive && activeTab !== 'all' && (
                  <div className="absolute bottom-0 left-3 right-3 h-0.5 rounded-full bg-blue-500" />
                )}
              </button>
            );
          })}
        </div>

        {/* ── Disputed Alert Banner (if any) ────────────────────── */}
        {disputedTickets.length > 0 && (
          <div
            id="disputed-council-section"
            className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg border border-yellow-600/30 bg-yellow-900/10 shrink-0"
          >
            <div className="flex items-center gap-2.5">
              <span className="w-2 h-2 rounded-full bg-yellow-500 shrink-0"></span>
              <span className="text-xs font-medium text-yellow-300">
                ⚖️ {disputedTickets.length} Council Split Verdict{disputedTickets.length > 1 ? 's' : ''} — Awaiting Human Decision
              </span>
              <span className="text-[10px] text-yellow-400/50 font-mono hidden sm:inline">
                Automated fixer retry paused for these tickets
              </span>
            </div>
            <button
              onClick={() => setDisputeModalTicket(disputedTickets[0])}
              className="bg-yellow-600 hover:bg-yellow-500 text-white font-medium px-3 py-1 rounded text-xs transition cursor-pointer flex items-center gap-1 shrink-0"
            >
              <span>Inspect</span>
              <span>→</span>
            </button>
          </div>
        )}

        {/* ── Main Ticket Table ─────────────────────────────────── */}
        {isLoading && tickets.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-20 text-slate-400 gap-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs">Loading ticket queue from orchestrator...</p>
          </div>
        ) : (
          <TicketTable
            tickets={filteredTickets}
            onApprove={handleApprove}
            onReject={handleReject}
            onInspectDispute={(ticket) => setDisputeModalTicket(ticket)}
          />
        )}

        {/* ── Footer Summary ────────────────────────────────────── */}
        <div className="shrink-0 flex items-center justify-between text-[10px] text-slate-500 font-mono px-1 pt-2 border-t border-slate-700/30">
          <span>
            Showing {filteredTickets.length} of {tickets.length} tickets
            {severityFilter !== 'all' && ` · filtered by ${severityFilter}`}
            {searchQuery && ` · matching "${searchQuery}"`}
          </span>
          <span>
            {wsConnected ? '● Live' : '○ Polling'} · {lastUpdated?.toLocaleTimeString() || '...'}
          </span>
        </div>
      </main>

      {/* Add Local Project Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                Add Local Project
              </h2>
              <button
                type="button"
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 text-sm cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateProject} className="p-6 space-y-4 text-xs overflow-y-auto flex-1">
              {createProjectError && (
                <div className="bg-rose-950/60 border border-rose-800 text-rose-300 p-2.5 rounded text-xs">
                  {createProjectError}
                </div>
              )}

              {/* Folder Picker Section */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-slate-300 font-medium">
                    Select Local Folder <span className="text-rose-400">*</span>
                  </label>
                  <button
                    type="button"
                    onClick={handleNativePick}
                    disabled={isPickingNative}
                    className="bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/50 text-indigo-200 text-xs px-2.5 py-1 rounded flex items-center gap-1.5 transition cursor-pointer"
                  >
                    <svg className="w-3.5 h-3.5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
                    </svg>
                    {isPickingNative ? 'Choosing in Finder...' : '📂 Choose in macOS Finder'}
                  </button>
                </div>

                {/* Quick Shortcuts */}
                {quickDirs.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-[11px] text-slate-500 font-medium">Quick jump:</span>
                    {quickDirs.map((qd) => (
                      <button
                        key={qd.path}
                        type="button"
                        onClick={() => handleBrowseTo(qd.path)}
                        className={`px-2 py-0.5 rounded text-[11px] border transition cursor-pointer ${
                          browseResult?.currentPath === qd.path
                            ? 'bg-indigo-600 border-indigo-500 text-white font-medium'
                            : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'
                        }`}
                      >
                        {qd.name}
                      </button>
                    ))}
                  </div>
                )}

                {/* In-Modal Visual Folder Explorer */}
                <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-slate-400 border-b border-slate-800/80 pb-2">
                    <div className="flex items-center gap-1.5 truncate max-w-[340px]">
                      <span className="text-slate-500">Path:</span>
                      <code className="text-indigo-300 font-mono truncate">
                        {browseResult?.currentPath || 'Select a folder'}
                      </code>
                    </div>
                    {browseResult?.parentPath && (
                      <button
                        type="button"
                        onClick={() => handleBrowseTo(browseResult.parentPath!)}
                        className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1 cursor-pointer bg-slate-800/70 px-2 py-0.5 rounded text-[11px]"
                      >
                        ⬆ Up One Folder
                      </button>
                    )}
                  </div>

                  {/* Directory list */}
                  <div className="max-h-40 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                    {isBrowsing ? (
                      <div className="flex items-center justify-center py-6 text-slate-500 gap-1.5">
                        <div className="w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                        <span>Loading folders...</span>
                      </div>
                    ) : browseResult && browseResult.directories.length > 0 ? (
                      <div className="grid grid-cols-2 gap-1.5">
                        {browseResult.directories.map((dir) => (
                          <button
                            key={dir.path}
                            type="button"
                            onClick={() => handleBrowseTo(dir.path)}
                            className="flex items-center gap-2 p-1.5 rounded text-left hover:bg-slate-800/80 text-slate-300 hover:text-white transition cursor-pointer border border-transparent hover:border-slate-700 truncate"
                          >
                            <span className="text-sm">📁</span>
                            <span className="truncate text-xs font-medium">{dir.name}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-4 text-slate-500 text-[11px]">
                        No subfolders found inside this directory.
                      </div>
                    )}
                  </div>
                </div>

                {/* Path input */}
                <div>
                  <input
                    type="text"
                    required
                    value={newProjectPath}
                    onChange={(e) => {
                      setNewProjectPath(e.target.value);
                      if (!newProjectName.trim()) {
                        const parts = e.target.value.split('/').filter(Boolean);
                        if (parts.length > 0) setNewProjectName(parts[parts.length - 1]);
                      }
                    }}
                    placeholder="Selected folder path will appear here"
                    className="w-full bg-slate-800/80 border border-slate-700 rounded px-3 py-1.5 text-slate-100 font-mono text-xs placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Project Name Field */}
              <div>
                <label className="block text-slate-300 font-medium mb-1.5">
                  Project Name <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="e.g. Mental Health App"
                  className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Optional GitHub Repo */}
              <div>
                <label className="block text-slate-300 font-medium mb-1.5">
                  GitHub Repository (Optional)
                </label>
                <input
                  type="text"
                  value={newProjectGithub}
                  onChange={(e) => setNewProjectGithub(e.target.value)}
                  placeholder="e.g. owner/repo-name"
                  className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-slate-100 font-mono text-xs placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2.5 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-3.5 py-1.5 rounded border border-slate-700 hover:bg-slate-800 text-slate-300 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreatingProject || !newProjectPath.trim()}
                  className="px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                >
                  {isCreatingProject ? 'Adding...' : 'Select & Add Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Council Dispute Inspection Modal */}
      {disputeModalTicket && (
        <CouncilDisputeModal
          ticket={disputeModalTicket}
          onClose={() => setDisputeModalTicket(null)}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}

    </div>
  );
}

export default App;
