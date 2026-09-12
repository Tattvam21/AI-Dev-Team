import React, { useState } from 'react';
import { Ticket, TicketSeverity } from '../types.js';

interface TicketCardProps {
  ticket: Ticket;
  onApprove?: (ticketId: string) => Promise<void>;
  onReject?: (ticketId: string) => Promise<void>;
  onInspectDispute?: (ticket: Ticket) => void;
}

function getSeverityBadge(severity: TicketSeverity) {
  switch (severity) {
    case 'critical':
      return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    case 'high':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'medium':
      return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
    case 'low':
      return 'bg-slate-500/15 text-slate-300 border-slate-700/60';
    default:
      return 'bg-slate-800 text-slate-300 border-slate-700';
  }
}

export const TicketCard: React.FC<TicketCardProps> = ({
  ticket,
  onApprove,
  onReject,
  onInspectDispute
}) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleApprove = async () => {
    if (!onApprove) return;
    setIsProcessing(true);
    setActionError(null);
    try {
      await onApprove(ticket.id);
    } catch (err: any) {
      setActionError(err.message || 'Approval failed');
      setIsProcessing(false);
    }
  };

  const handleReject = async () => {
    if (!onReject) return;
    setIsProcessing(true);
    setActionError(null);
    try {
      await onReject(ticket.id);
    } catch (err: any) {
      setActionError(err.message || 'Rejection failed');
      setIsProcessing(false);
    }
  };

  const confidencePct = Math.round(ticket.confidence * 100);
  const filePath = ticket.symptomFile?.path || null;
  const lineRange =
    ticket.lineStart !== null && ticket.lineStart !== undefined
      ? ticket.lineEnd && ticket.lineEnd !== ticket.lineStart
        ? `L${ticket.lineStart}-${ticket.lineEnd}`
        : `L${ticket.lineStart}`
      : null;

  return (
    <div className="group relative bg-[#0d1424]/95 hover:bg-[#111a30] border border-slate-800/90 hover:border-indigo-500/40 rounded-lg p-3 transition-all duration-150 shadow-sm hover:shadow-md flex flex-col gap-2">
      {/* Top row: Severity, Ticket Short ID, Confidence */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider border ${getSeverityBadge(
              ticket.severity
            )}`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-current" />
            {ticket.severity}
          </span>
          <span className="text-slate-500 font-mono text-[10px]">
            #{ticket.id.slice(0, 7)}
          </span>
        </div>

        <div className="flex items-center gap-1 text-slate-400 font-mono text-[10px] bg-slate-800/80 px-1.5 py-0.5 rounded border border-slate-700/50">
          <span className={confidencePct >= 80 ? 'text-emerald-400' : confidencePct >= 50 ? 'text-amber-400' : 'text-rose-400'}>
            ●
          </span>
          <span>{confidencePct}% conf</span>
        </div>
      </div>

      {/* Disputed Council Banner */}
      {ticket.status === 'awaiting_human_dispute' && (
        <div className="bg-amber-950/60 border border-amber-500/50 text-amber-200 text-[11px] p-2.5 rounded-md flex flex-col gap-1.5 shadow-inner">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-bold text-amber-300">
              <span>⚖️</span>
              <span>Council Split Verdict</span>
            </span>
            <span className="text-[10px] bg-amber-900/80 px-1.5 py-0.5 rounded font-mono border border-amber-600/50 text-amber-200">
              Disputed
            </span>
          </div>
          <p className="text-[10px] text-amber-300/80 leading-snug">
            Multi-model council split. Fixer paused.
          </p>
          {onInspectDispute && (
            <button
              onClick={() => onInspectDispute(ticket)}
              className="mt-0.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/50 hover:border-amber-400 py-1 px-2 rounded text-[11px] font-medium flex items-center justify-center gap-1 transition cursor-pointer"
            >
              <span>🔍</span>
              <span>Inspect Council Debate</span>
            </button>
          )}
        </div>
      )}

      {/* Ticket Title */}
      <h4 className="text-slate-100 font-semibold text-xs leading-snug line-clamp-2 group-hover:text-white">
        {ticket.title}
      </h4>

      {/* Description Snippet */}
      {ticket.description && (
        <p className="text-slate-400 text-[11px] line-clamp-2 leading-relaxed">
          {ticket.description}
        </p>
      )}

      {/* Code Context Location */}
      {filePath && (
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-300 bg-slate-900/90 border border-slate-800 px-2 py-1 rounded truncate">
          <span className="text-slate-500">📄</span>
          <span className="truncate flex-1" title={filePath}>{filePath}</span>
          {lineRange && <span className="text-indigo-400 font-semibold shrink-0">{lineRange}</span>}
        </div>
      )}

      {/* Model and Action Footer */}
      <div className="pt-1 flex items-center justify-between gap-1 text-[10px] text-slate-500 border-t border-slate-800/60">
        <span className="flex items-center gap-1">
          <span>Agent:</span>
          <code className="text-slate-400 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
            {ticket.scannerModel}
          </code>
        </span>
        <span className="capitalize text-slate-400 font-medium">
          {ticket.status.replace('_', ' ')}
        </span>
      </div>

      {/* Action Error Message */}
      {actionError && (
        <div className="text-[10px] text-rose-300 bg-rose-950/70 border border-rose-800/70 rounded px-2 py-1">
          {actionError}
        </div>
      )}

      {/* Interactive Actions for Triaged or Awaiting Human tickets */}
      {(ticket.status === 'triaged' || ticket.status === 'awaiting_human' || ticket.status === 'awaiting_human_dispute') && (
        <div className="pt-1.5 border-t border-slate-800/80 flex items-center gap-2">
          <button
            onClick={handleApprove}
            disabled={isProcessing}
            className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium text-xs py-1.5 px-2.5 rounded shadow transition cursor-pointer flex items-center justify-center gap-1"
          >
            {isProcessing ? (
              <span>Saving...</span>
            ) : (
              <>
                <span>✓</span>
                <span>{ticket.status === 'awaiting_human_dispute' ? 'Approve Override' : 'Approve'}</span>
              </>
            )}
          </button>
          <button
            onClick={handleReject}
            disabled={isProcessing}
            className="bg-slate-800 hover:bg-rose-950/40 text-slate-300 hover:text-rose-300 hover:border-rose-700/60 disabled:opacity-50 border border-slate-700 font-medium text-xs py-1.5 px-2.5 rounded transition cursor-pointer flex items-center justify-center gap-1"
          >
            <span>✕</span>
            <span>Reject</span>
          </button>
        </div>
      )}
    </div>
  );
};
