'use client';

const BADGE_STYLES: Record<string, string> = {
  confirmed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  '1_confirm': 'bg-emerald-100 text-emerald-800 border-emerald-200',
  synced: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  completed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  answered: 'bg-sky-100 text-sky-800 border-sky-200',
  calling: 'bg-sky-100 text-sky-800 border-sky-200',
  ringing: 'bg-sky-100 text-sky-800 border-sky-200',
  queued: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  pending: 'bg-slate-100 text-slate-700 border-slate-200',
  whatsapp_requested: 'bg-teal-100 text-teal-800 border-teal-200',
  '3_whatsapp': 'bg-teal-100 text-teal-800 border-teal-200',
  cancellation_requested: 'bg-amber-100 text-amber-800 border-amber-200',
  cancelled: 'bg-rose-100 text-rose-800 border-rose-200',
  '2_cancel': 'bg-rose-100 text-rose-800 border-rose-200',
  pending_sync: 'bg-amber-100 text-amber-900 border-amber-300',
  no_answer: 'bg-orange-100 text-orange-800 border-orange-200',
  no_response: 'bg-orange-100 text-orange-800 border-orange-200',
  no_input: 'bg-orange-100 text-orange-800 border-orange-200',
  invalid_input: 'bg-amber-100 text-amber-800 border-amber-200',
  invalid_key: 'bg-amber-100 text-amber-800 border-amber-200',
  failed: 'bg-red-100 text-red-800 border-red-200',
  dead_letter: 'bg-red-100 text-red-900 border-red-300',
  ineligible: 'bg-slate-100 text-slate-600 border-slate-200',
  suppressed_opt_out: 'bg-purple-100 text-purple-800 border-purple-200',
};

export function StatusBadge({ value }: { value: string | null | undefined }) {
  const key = (value || 'none').toLowerCase();
  const cls = BADGE_STYLES[key] || 'bg-slate-100 text-slate-700 border-slate-200';
  const label = key.replace(/_/g, ' ');
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border capitalize ${cls}`}>
      {label}
    </span>
  );
}
