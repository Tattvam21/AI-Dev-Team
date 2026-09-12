import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchTickets, approveTicket, rejectTicket, triggerScan, ApiError } from './api.js';

describe('Dashboard API Client', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetchTickets calls GET /api/projects/:id/tickets with params', async () => {
    const mockTickets = [
      { id: 't1', title: 'Bug 1', status: 'found', severity: 'high', confidence: 0.9 }
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockTickets
    } as Response);

    const res = await fetchTickets('p1', { status: 'found', severity: 'high' });
    expect(res).toEqual(mockTickets);
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/p1/tickets?status=found&severity=high');
  });

  it('approveTicket calls POST /api/tickets/:id/approve', async () => {
    const mockRes = { ticket: { id: 't1', status: 'approved' }, jobId: 'j1', message: 'Approved' };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockRes
    } as Response);

    const res = await approveTicket('t1');
    expect(res).toEqual(mockRes);
    expect(global.fetch).toHaveBeenCalledWith('/api/tickets/t1/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
  });

  it('rejectTicket calls POST /api/tickets/:id/reject with reason', async () => {
    const mockRes = { ticket: { id: 't1', status: 'rejected' }, message: 'Rejected' };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockRes
    } as Response);

    const res = await rejectTicket('t1', 'False positive');
    expect(res).toEqual(mockRes);
    expect(global.fetch).toHaveBeenCalledWith('/api/tickets/t1/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'False positive' })
    });
  });

  it('throws ApiError with message on non-ok HTTP response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({ message: 'Cannot approve ticket with status found' })
    } as Response);

    await expect(approveTicket('t1')).rejects.toThrow(ApiError);
    await expect(approveTicket('t1')).rejects.toThrow('Cannot approve ticket with status found');
  });

  it('triggerScan calls POST /api/projects/:id/scan', async () => {
    const mockRes = { success: true, jobId: 'scan-1', message: 'Enqueued' };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockRes
    } as Response);

    const res = await triggerScan('p1');
    expect(res).toEqual(mockRes);
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/p1/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

  });
});
