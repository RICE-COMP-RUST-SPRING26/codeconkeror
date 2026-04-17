import type { EventLogEntry } from '../types';

function fmtTime(d: Date) {
  return d.toTimeString().slice(0, 8);
}

interface EventLogPanelProps {
  entries: EventLogEntry[];
  onClear: () => void;
}

export default function EventLogPanel({ entries, onClear }: EventLogPanelProps) {
  return (
    <div className="border border-gray-200 rounded bg-white overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 bg-gray-50">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Event log</p>
        <button onClick={onClear} className="text-xs text-gray-400 hover:text-gray-600">
          Clear
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-gray-400 p-3">(no events yet)</p>
      ) : (
        <ul className="max-h-52 overflow-y-auto divide-y divide-gray-50">
          {[...entries].reverse().map((entry) => (
            <li key={entry.id} className="px-3 py-1 text-xs font-mono flex gap-3 items-baseline">
              <span className="text-gray-400 flex-shrink-0">{fmtTime(entry.time)}</span>
              <span
                className={`flex-shrink-0 font-semibold ${
                  entry.direction === 'in' ? 'text-blue-600' : 'text-orange-600'
                }`}
              >
                {entry.direction === 'in' ? '←' : '→'} {entry.type}
              </span>
              <span className="text-gray-600 truncate">{entry.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
