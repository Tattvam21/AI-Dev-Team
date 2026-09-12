import React from 'react';
import { Ticket } from '../types.js';
import { TicketCard } from './TicketCard.js';

interface KanbanColumnProps {
  id: string;
  title: string;
  tickets: Ticket[];
  badgeColor: string;
  onApprove?: (ticketId: string) => Promise<void>;
  onReject?: (ticketId: string) => Promise<void>;
  onInspectDispute?: (ticket: Ticket) => void;
}

const EMPTY_STATE_MESSAGES: Record<string, { label: string; sub: string; icon: string }> = {
  found: { label: 'No Pending Issues', sub: 'Run a codebase scan to detect anomalies', icon: '🔍' },
  triaged: { label: 'Triage Queue Clear', sub: 'All tickets triaged or approved', icon: '📋' },
  approved: { label: 'No Active Fixes', sub: 'Fixer agent standing by', icon: '⚡' },
  in_review: { label: 'No In-flight Reviews', sub: 'Reviewer council idle', icon: '🧪' },
  awaiting_human: { label: 'All Clear', sub: 'No patches awaiting human sign-off', icon: '✓' },
  pushed: { label: 'No Pushed PRs', sub: 'Merged patches will appear here', icon: '🚀' }
};

export const KanbanColumn: React.FC<KanbanColumnProps> = ({
  id,
  title,
  tickets,
  badgeColor,
  onApprove,
  onReject,
  onInspectDispute
}) => {
  const emptyMeta = EMPTY_STATE_MESSAGES[id] || { label: 'Queue Empty', sub: 'No tickets in this stage', icon: '•' };

  return (
    <div
      data-column-id={id}
      className="flex flex-col flex-1 min-w-[260px] w-full bg-[#0a101f]/80 border border-slate-800/80 hover:border-slate-700/80 transition-colors rounded-xl p-3 shadow-sm backdrop-blur-sm"
    >
      {/* Column Header */}
      <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-slate-800/80">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${badgeColor} shadow-sm`} />
          <h3 className="font-semibold text-xs text-slate-200 uppercase tracking-wider">
            {title}
          </h3>
        </div>
        <span className={`text-[11px] font-mono px-2 py-0.5 rounded-full font-semibold border ${
          tickets.length > 0
            ? 'bg-slate-800 text-indigo-300 border-indigo-900/60'
            : 'bg-slate-900/60 text-slate-500 border-slate-800'
        }`}>
          {tickets.length}
        </span>
      </div>

      {/* Ticket List */}
      <div className="flex-1 flex flex-col gap-2.5 overflow-y-auto max-h-[calc(100vh-250px)] pr-1">
        {tickets.length === 0 ? (
          <div className="flex-1 min-h-[140px] flex flex-col items-center justify-center p-4 text-center rounded-lg border border-dashed border-slate-800/80 bg-slate-900/20 text-slate-500">
            <span className="text-xl mb-1 opacity-60">{emptyMeta.icon}</span>
            <p className="text-xs font-medium text-slate-400">{emptyMeta.label}</p>
            <p className="text-[10px] text-slate-500 mt-0.5 max-w-[160px] leading-tight">{emptyMeta.sub}</p>
          </div>
        ) : (
          tickets.map((ticket) => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              onApprove={onApprove}
              onReject={onReject}
              onInspectDispute={onInspectDispute}
            />
          ))
        )}
      </div>
    </div>
  );
};
