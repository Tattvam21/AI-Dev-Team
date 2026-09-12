import React, { useEffect, useState } from 'react';
import { Ticket, Review, TicketSeverity } from '../types.js';
import { fetchTicketReviews } from '../api.js';

interface CouncilDisputeModalProps {
  ticket: Ticket;
  onClose: () => void;
  onApprove: (ticketId: string) => Promise<void>;
  onReject: (ticketId: string) => Promise<void>;
}

function getSeverityBadge(severity: TicketSeverity) {
  switch (severity) {
    case 'critical':
      return 'bg-red-950/80 text-red-300 border-red-700/60';
    case 'high':
      return 'bg-amber-950/80 text-amber-300 border-amber-700/60';
    case 'medium':
      return 'bg-yellow-950/80 text-yellow-300 border-yellow-700/60';
    case 'low':
      return 'bg-sky-950/80 text-sky-300 border-sky-700/60';
    default:
      return 'bg-slate-800 text-slate-300 border-slate-700';
  }
}

export const CouncilDisputeModal: React.FC<CouncilDisputeModalProps> = ({
  ticket,
  onClose,
  onApprove,
  onReject
}) => {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchTicketReviews(ticket.id)
      .then((data) => {
        setReviews(data);
      })
      .catch((err) => {
        setError(err.message || 'Failed to load council reviews');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [ticket.id]);

  const handleApprove = async () => {
    setIsProcessing(true);
    setActionError(null);
    try {
      await onApprove(ticket.id);
      onClose();
    } catch (err: any) {
      setActionError(err.message || 'Approval failed');
      setIsProcessing(false);
    }
  };

  const handleReject = async () => {
    setIsProcessing(true);
    setActionError(null);
    try {
      await onReject(ticket.id);
      onClose();
    } catch (err: any) {
      setActionError(err.message || 'Rejection failed');
      setIsProcessing(false);
    }
  };

  const memberReviews = reviews.filter((r) => !r.is_final_verdict);
  const finalReview = reviews.find((r) => r.is_final_verdict);

  const passVotes = memberReviews.filter((r) => r.verdict === 'pass').length;
  const failVotes = memberReviews.filter((r) => r.verdict === 'fail').length;

  return (
    <div
      id="council-dispute-modal"
      className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4 overflow-y-auto"
    >
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl w-full max-w-5xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-amber-950/60 via-slate-900 to-rose-950/60 border-b border-slate-800 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5 mb-1.5">
              <span className="bg-amber-500/20 text-amber-300 border border-amber-500/50 text-[11px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider flex items-center gap-1.5 shadow-sm">
                <span>⚖️</span>
                <span>Council Deliberation Dispute</span>
              </span>
              <span
                className={`text-[11px] font-semibold px-2 py-0.5 rounded uppercase tracking-wider border ${getSeverityBadge(
                  ticket.severity
                )}`}
              >
                {ticket.severity}
              </span>
            </div>
            <h2 className="text-lg font-bold text-slate-100 leading-snug">
              {ticket.title}
            </h2>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Council vote is split evenly ({passVotes} PASS vs {failVotes} FAIL). No clear majority was reached. Inspect each model's independent verdict and notes below to resolve.
            </p>
          </div>

          <button
            id="close-dispute-modal-btn"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 p-6 overflow-y-auto space-y-6">
          {actionError && (
            <div className="bg-rose-950/70 border border-rose-800 text-rose-300 text-xs p-3 rounded-lg flex items-center justify-between">
              <span>{actionError}</span>
            </div>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-slate-400">
              <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-xs">Fetching council members' deliberation reports...</p>
            </div>
          ) : error ? (
            <div className="bg-rose-950/60 border border-rose-800 text-rose-300 p-4 rounded-xl text-xs">
              {error}
            </div>
          ) : (
            <>
              {/* Tally Summary Bar */}
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 shadow-inner">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-400 uppercase tracking-wider font-semibold">
                    Vote Breakdown:
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 font-mono text-xs px-2.5 py-1 rounded-md flex items-center gap-1.5 font-bold">
                      <span>✓</span> {passVotes} Pass
                    </span>
                    <span className="bg-rose-950/80 text-rose-300 border border-rose-700/60 font-mono text-xs px-2.5 py-1 rounded-md flex items-center gap-1.5 font-bold">
                      <span>✕</span> {failVotes} Fail
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-400">Total Deliberating Models:</span>
                  <span className="font-mono text-slate-200 font-semibold bg-slate-800 px-2 py-0.5 rounded">
                    {memberReviews.length}
                  </span>
                </div>
              </div>

              {/* Side-by-Side Council Member Cards */}
              <div>
                <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                  Council Members' Individual Deliberations
                </h3>

                {memberReviews.length === 0 ? (
                  <p className="text-xs text-slate-500 italic">No member review rows found.</p>
                ) : (
                  <div
                    className={`grid gap-4 ${
                      memberReviews.length === 2
                        ? 'grid-cols-1 md:grid-cols-2'
                        : 'grid-cols-1 md:grid-cols-3'
                    }`}
                  >
                    {memberReviews.map((m, idx) => (
                      <div
                        key={m.id || idx}
                        data-member-card={idx}
                        className={`rounded-xl border p-4 flex flex-col gap-3 shadow-md transition ${
                          m.verdict === 'pass'
                            ? 'bg-slate-900/90 border-emerald-800/60 shadow-emerald-950/20'
                            : m.verdict === 'fail'
                            ? 'bg-slate-900/90 border-rose-800/60 shadow-rose-950/20'
                            : 'bg-slate-900/90 border-amber-800/60 shadow-amber-950/20'
                        }`}
                      >
                        {/* Member Header */}
                        <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-mono font-bold bg-slate-800 text-slate-300 px-2 py-0.5 rounded">
                              Member #{m.council_member !== null && m.council_member !== undefined ? m.council_member : idx}
                            </span>
                            <span className="text-xs font-mono text-indigo-300 truncate max-w-[140px]" title={m.reviewerModel}>
                              {m.reviewerModel}
                            </span>
                          </div>

                          <span
                            className={`text-[11px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-wider ${
                              m.verdict === 'pass'
                                ? 'bg-emerald-950 text-emerald-300 border-emerald-600'
                                : m.verdict === 'fail'
                                ? 'bg-rose-950 text-rose-300 border-rose-600'
                                : 'bg-amber-950 text-amber-300 border-amber-600'
                            }`}
                          >
                            {m.verdict === 'pass' ? '✓ Pass' : m.verdict === 'fail' ? '✕ Fail' : m.verdict}
                          </span>
                        </div>

                        {/* Member Notes / What the model said */}
                        <div className="flex-1 flex flex-col gap-1.5">
                          <span className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">
                            Model Finding & Rationale:
                          </span>
                          <div className="text-xs text-slate-200 bg-slate-950/70 p-3 rounded-lg border border-slate-800/90 font-mono leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto">
                            {m.notes || '(No notes provided)'}
                          </div>
                        </div>

                        <div className="text-[10px] text-slate-500 font-mono pt-1">
                          Reviewed: {new Date(m.reviewedAt).toLocaleTimeString()}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Final Aggregated Synthesis Row */}
              {finalReview && (
                <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                      <span>📋</span> Final Aggregated Decision Row
                    </span>
                    <span className="text-xs font-bold font-mono px-2 py-0.5 rounded bg-amber-950 border border-amber-600/70 text-amber-300">
                      STATUS: {finalReview.verdict.toUpperCase()}
                    </span>
                  </div>
                  <div className="text-xs text-slate-300 bg-slate-900/80 p-3 rounded-lg border border-slate-800 font-mono whitespace-pre-wrap">
                    {finalReview.notes}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer Actions for Human Resolution */}
        <div className="px-6 py-4 bg-slate-950 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-slate-400">
            Adjudicate this ticket: human decision overrides council split vote.
          </div>

          <div className="flex items-center gap-3">
            <button
              id="dispute-reject-btn"
              onClick={handleReject}
              disabled={isProcessing}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-rose-950/60 hover:text-rose-300 hover:border-rose-700/60 text-slate-300 border border-slate-700 text-xs font-semibold transition cursor-pointer disabled:opacity-50"
            >
              {isProcessing ? 'Working...' : 'Reject Patch'}
            </button>

            <button
              id="dispute-approve-btn"
              onClick={handleApprove}
              disabled={isProcessing}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md transition cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
            >
              <span>✓</span>
              <span>{isProcessing ? 'Working...' : 'Approve Patch (Override Split)'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
