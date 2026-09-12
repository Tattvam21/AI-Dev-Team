import React, { useState } from 'react';
import { Ticket, TicketSeverity } from '../types.js';

interface TicketTableProps {
  tickets: Ticket[];
  onApprove: (ticketId: string) => Promise<void>;
  onReject: (ticketId: string) => Promise<void>;
  onInspectDispute?: (ticket: Ticket) => void;
}

/* ── Status styling — muted, professional palette ──────── */
const STATUS_STYLE: Record<string, { dot: string; bg: string; text: string; label: string }> = {
  found:                  { dot: 'bg-yellow-600',  bg: 'bg-yellow-900/15',  text: 'text-yellow-400',  label: 'Found' },
  triaged:                { dot: 'bg-blue-500',    bg: 'bg-blue-900/15',    text: 'text-blue-400',    label: 'Triaged' },
  approved:               { dot: 'bg-green-600',   bg: 'bg-green-900/15',   text: 'text-green-400',   label: 'Approved' },
  in_review:              { dot: 'bg-violet-500',  bg: 'bg-violet-900/15',  text: 'text-violet-400',  label: 'In Review' },
  awaiting_human:         { dot: 'bg-orange-500',  bg: 'bg-orange-900/15',  text: 'text-orange-400',  label: 'Awaiting Human' },
  awaiting_human_dispute: { dot: 'bg-yellow-500',  bg: 'bg-yellow-900/15',  text: 'text-yellow-300',  label: 'Disputed' },
  pushed:                 { dot: 'bg-slate-400',   bg: 'bg-slate-700/20',   text: 'text-slate-300',   label: 'Pushed' },
};

const SEV_STYLE: Record<TicketSeverity, { bg: string; text: string }> = {
  critical: { bg: 'bg-red-900/20 border-red-700/30',     text: 'text-red-400' },
  high:     { bg: 'bg-orange-900/20 border-orange-700/30', text: 'text-orange-400' },
  medium:   { bg: 'bg-blue-900/20 border-blue-700/30',    text: 'text-blue-400' },
  low:      { bg: 'bg-slate-700/20 border-slate-600/30',   text: 'text-slate-400' },
};

export const TicketTable: React.FC<TicketTableProps> = ({
  tickets,
  onApprove,
  onReject,
  onInspectDispute,
}) => {
  const [processingId, setProcessingId] = useState<string | null>(null);

  const handleAction = async (id: string, action: 'approve' | 'reject') => {
    setProcessingId(id);
    try {
      if (action === 'approve') await onApprove(id);
      else await onReject(id);
    } catch {
      // swallow — parent refreshes
    } finally {
      setProcessingId(null);
    }
  };

  if (tickets.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-20 text-slate-500">
        <div className="text-4xl mb-3 opacity-30">📋</div>
        <p className="text-sm font-medium text-slate-400">No tickets match your filters</p>
        <p className="text-xs text-slate-500 mt-1">Try adjusting the severity or stage filter above</p>
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto rounded-lg border border-slate-700/40 bg-[#16191f]">
      <table className="w-full text-left text-xs">
        {/* ── Table Header ─────────────────────────── */}
        <thead>
          <tr className="border-b border-slate-700/50 bg-[#1a1d24] text-[11px] text-slate-400 uppercase tracking-wider font-medium">
            <th className="py-2.5 px-4 w-[130px]">Status</th>
            <th className="py-2.5 px-3 w-[80px]">Severity</th>
            <th className="py-2.5 px-3">Title</th>
            <th className="py-2.5 px-3 w-[220px] hidden lg:table-cell">File</th>
            <th className="py-2.5 px-3 w-[75px] text-center hidden md:table-cell">Confidence</th>
            <th className="py-2.5 px-3 w-[120px] hidden xl:table-cell">Agent</th>
            <th className="py-2.5 px-4 w-[170px] text-right">Actions</th>
          </tr>
        </thead>

        {/* ── Table Body ───────────────────────────── */}
        <tbody>
          {tickets.map((ticket, idx) => {
            const st = STATUS_STYLE[ticket.status] || STATUS_STYLE.found;
            const sev = SEV_STYLE[ticket.severity] || SEV_STYLE.low;
            const conf = Math.round(ticket.confidence * 100);
            const isProcessing = processingId === ticket.id;
            const showActions = ticket.status === 'triaged' || ticket.status === 'awaiting_human' || ticket.status === 'awaiting_human_dispute';
            const isDisputed = ticket.status === 'awaiting_human_dispute';
            const filePath = ticket.symptomFile?.path || null;
            const lineRange =
              ticket.lineStart != null
                ? ticket.lineEnd && ticket.lineEnd !== ticket.lineStart
                  ? `L${ticket.lineStart}-${ticket.lineEnd}`
                  : `L${ticket.lineStart}`
                : null;

            return (
              <tr
                key={ticket.id}
                className={`border-b border-slate-700/30 transition-colors hover:bg-[#1e2128] group ${
                  idx % 2 === 0 ? 'bg-transparent' : 'bg-slate-800/10'
                }`}
              >
                {/* Status */}
                <td className="py-2.5 px-4">
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium ${st.bg} ${st.text}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                    {isDisputed && <span className="mr-[-2px]">⚖️</span>}
                    {st.label}
                  </span>
                </td>

                {/* Severity */}
                <td className="py-2.5 px-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider border ${sev.bg} ${sev.text}`}>
                    {ticket.severity}
                  </span>
                </td>

                {/* Title + ID */}
                <td className="py-2.5 px-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-slate-200 font-medium text-xs leading-snug line-clamp-1 group-hover:text-white transition-colors">
                      {ticket.title}
                    </span>
                    <span className="text-[10px] font-mono text-slate-500">
                      #{ticket.id.slice(0, 8)}
                      {ticket.description && (
                        <span className="ml-2 font-sans text-slate-500 hidden xl:inline">
                          — {ticket.description.slice(0, 80)}{ticket.description.length > 80 ? '…' : ''}
                        </span>
                      )}
                    </span>
                  </div>
                </td>

                {/* File */}
                <td className="py-2.5 px-3 hidden lg:table-cell">
                  {filePath ? (
                    <div className="font-mono text-[10px] text-slate-400 truncate max-w-[200px] flex items-center gap-1" title={filePath}>
                      <span className="text-slate-500 shrink-0">📄</span>
                      <span className="truncate">{filePath}</span>
                      {lineRange && <span className="text-blue-400 font-semibold shrink-0">{lineRange}</span>}
                    </div>
                  ) : (
                    <span className="text-slate-600 text-[10px]">—</span>
                  )}
                </td>

                {/* Confidence */}
                <td className="py-2.5 px-3 hidden md:table-cell">
                  <div className="flex items-center justify-center gap-1.5">
                    <div className="w-10 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          conf >= 80 ? 'bg-green-600' : conf >= 50 ? 'bg-yellow-600' : 'bg-red-600'
                        }`}
                        style={{ width: `${conf}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-slate-400 w-7 text-right">{conf}%</span>
                  </div>
                </td>

                {/* Agent */}
                <td className="py-2.5 px-3 hidden xl:table-cell">
                  <code className="text-[10px] text-slate-400 bg-slate-800/50 border border-slate-700/40 px-1.5 py-0.5 rounded">
                    {ticket.scannerModel}
                  </code>
                </td>

                {/* Actions */}
                <td className="py-2.5 px-4 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    {isDisputed && onInspectDispute && (
                      <button
                        onClick={() => onInspectDispute(ticket)}
                        className="text-yellow-300 hover:text-yellow-200 bg-yellow-900/20 hover:bg-yellow-900/30 border border-yellow-600/30 text-[11px] font-medium px-2 py-1 rounded transition cursor-pointer"
                      >
                        Inspect
                      </button>
                    )}
                    {showActions && (
                      <>
                        <button
                          onClick={() => handleAction(ticket.id, 'approve')}
                          disabled={isProcessing}
                          className="bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white text-[11px] font-medium px-2.5 py-1 rounded transition cursor-pointer"
                        >
                          {isProcessing ? '…' : '✓ Approve'}
                        </button>
                        <button
                          onClick={() => handleAction(ticket.id, 'reject')}
                          disabled={isProcessing}
                          className="bg-slate-700 hover:bg-red-900/40 hover:text-red-300 hover:border-red-700/40 disabled:opacity-40 text-slate-300 border border-slate-600 text-[11px] font-medium px-2 py-1 rounded transition cursor-pointer"
                        >
                          ✕
                        </button>
                      </>
                    )}
                    {!showActions && !isDisputed && (
                      <span className="text-[10px] text-slate-600">—</span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
