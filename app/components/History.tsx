"use client";

import { useCallback, useEffect, useState } from "react";

export type HistoryEntry = {
  id: string;
  text: string;
  voice: string;
  timestamp: number;
  audioBase64: string;
};

type HistoryInput = Omit<HistoryEntry, "id" | "timestamp">;

type HistoryProps = {
  entries: HistoryEntry[];
  getVoiceLabel: (voice: string) => string;
  onSelect: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
};

const HISTORY_KEY = "tts-history";
const MAX_HISTORY_ITEMS = 20;
const MAX_HISTORY_BYTES = 5 * 1024 * 1024;

function getStorageBytes(entries: HistoryEntry[]) {
  const serialized = JSON.stringify(entries);

  if (typeof Blob !== "undefined") {
    return new Blob([serialized]).size;
  }

  return serialized.length;
}

function trimHistory(entries: HistoryEntry[]) {
  let next = entries.slice(0, MAX_HISTORY_ITEMS);

  while (next.length > 0 && getStorageBytes(next) > MAX_HISTORY_BYTES) {
    next = next.slice(0, -1);
  }

  return next;
}

function formatRelativeTime(timestamp: number) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));

  if (elapsedSeconds < 60) return "just now";

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

export function useHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as HistoryEntry[];
      if (Array.isArray(parsed)) {
        setEntries(trimHistory(parsed));
      }
    } catch {
      localStorage.removeItem(HISTORY_KEY);
    }
  }, []);

  const addEntry = useCallback(
    (entry: HistoryInput) => {
      const nextEntry: HistoryEntry = {
        ...entry,
        id: `history-${Date.now()}`,
        timestamp: Date.now(),
      };
      const next = trimHistory([nextEntry, ...entries]);
      const stored = next.some((item) => item.id === nextEntry.id);
      const saved = stored && saveHistory(next);

      if (saved) {
        setEntries(next);
      }

      return saved;
    },
    [entries],
  );

  const deleteEntry = useCallback((id: string) => {
    setEntries((current) => {
      const next = current.filter((entry) => entry.id !== id);
      saveHistory(next);
      return next;
    });
  }, []);

  const clearEntries = useCallback(() => {
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* Storage may be unavailable in private browsing modes. */
    }
    setEntries([]);
  }, []);

  return {
    historyEntries: entries,
    addHistoryEntry: addEntry,
    deleteHistoryEntry: deleteEntry,
    clearHistory: clearEntries,
  };
}

export function History({
  entries,
  getVoiceLabel,
  onSelect,
  onDelete,
  onClear,
}: HistoryProps) {
  const [open, setOpen] = useState(false);

  return (
    <aside className={`history-sidebar ${open ? "open" : ""}`}>
      <button
        className="history-toggle"
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        History
      </button>
      <div className="history-panel">
        <div className="history-header">
          <div>
            <div className="history-kicker">Archive</div>
            <h2>History</h2>
          </div>
        </div>

        <div className="history-list">
          {entries.length === 0 ? (
            <div className="history-empty">Nothing here yet.</div>
          ) : (
            entries.map((entry) => (
              <div
                className="history-entry"
                key={entry.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(entry)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(entry);
                  }
                }}
              >
                <span className="history-entry-text">
                  {entry.text.slice(0, 80)}
                  {entry.text.length > 80 ? "..." : ""}
                </span>
                <span className="history-entry-meta">
                  {getVoiceLabel(entry.voice)} / {formatRelativeTime(entry.timestamp)}
                </span>
                <button
                  className="history-delete"
                  type="button"
                  aria-label="Delete history entry"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(entry.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>

        <button
          className="history-clear"
          type="button"
          onClick={onClear}
          disabled={entries.length === 0}
        >
          Clear history
        </button>
      </div>
    </aside>
  );
}
