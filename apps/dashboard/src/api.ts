import { Ticket, Review } from './types.js';

const API_BASE = ((import.meta as any).env?.VITE_API_URL as string) || '/api';

export class ApiError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let errorMsg = `HTTP Error ${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data.message) {
        errorMsg = data.message;
      }
    } catch {
      // ignore
    }
    throw new ApiError(errorMsg, res.status);
  }
  return res.json() as Promise<T>;
}

export async function fetchTickets(
  projectId: string,
  filters?: { status?: string; severity?: string }
): Promise<Ticket[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.severity) params.set('severity', filters.severity);

  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${API_BASE}/projects/${projectId}/tickets${qs}`);
  return handleResponse<Ticket[]>(res);
}

export async function approveTicket(
  ticketId: string
): Promise<{ ticket: Ticket; jobId: string; message: string }> {
  const res = await fetch(`${API_BASE}/tickets/${ticketId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  return handleResponse(res);
}

export async function rejectTicket(
  ticketId: string,
  reason?: string
): Promise<{ ticket: Ticket; message: string }> {
  const res = await fetch(`${API_BASE}/tickets/${ticketId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason || '' })
  });
  return handleResponse(res);
}

export async function triggerScan(
  projectId: string
): Promise<{ success: boolean; jobId: string; message: string }> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  return handleResponse(res);
}



export interface ProjectItem {
  id: string;
  name: string;
  localPath?: string | null;
  githubRepo?: string | null;
  _count?: { tickets: number };
}

export async function fetchProjects(): Promise<ProjectItem[]> {
  const res = await fetch(`${API_BASE}/projects`);
  return handleResponse<ProjectItem[]>(res);
}

export async function createProject(data: {
  name: string;
  localPath?: string;
  githubRepo?: string;
}): Promise<ProjectItem> {
  const res = await fetch(`${API_BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return handleResponse<ProjectItem>(res);
}

export interface QuickDir {
  name: string;
  path: string;
}

export interface BrowseResult {
  currentPath: string;
  parentPath: string | null;
  directories: { name: string; path: string }[];
}

export async function fetchQuickDirs(): Promise<QuickDir[]> {
  const res = await fetch(`${API_BASE}/fs/quick-dirs`);
  const data = await handleResponse<{ quickDirs: QuickDir[] }>(res);
  return data.quickDirs;
}

export async function browseDirectory(dirPath?: string): Promise<BrowseResult> {
  const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
  const res = await fetch(`${API_BASE}/fs/browse${qs}`);
  return handleResponse<BrowseResult>(res);
}

export async function pickNativeFolder(): Promise<{ path?: string; cancelled: boolean }> {
  const res = await fetch(`${API_BASE}/fs/pick-folder`, {
    method: 'POST'
  });
  return handleResponse<{ path?: string; cancelled: boolean }>(res);
}

export async function fetchPatchReviews(patchId: string): Promise<Review[]> {
  const res = await fetch(`${API_BASE}/patches/${patchId}/reviews`);
  return handleResponse<Review[]>(res);
}

export async function fetchTicketReviews(ticketId: string): Promise<Review[]> {
  const res = await fetch(`${API_BASE}/tickets/${ticketId}/reviews`);
  return handleResponse<Review[]>(res);
}



