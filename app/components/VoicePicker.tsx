"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  getVoiceFlag,
  getVoiceName,
  type Voice,
} from "@/app/lib/voices";
import { cancelBrowserSpeech, speakTextWithBrowser } from "@/app/lib/browserSpeech";

type VoicePickerProps = {
  voices: Voice[];
  value: string;
  onChange: (voiceId: string) => void;
};

export function VoicePicker({ voices, value, onChange }: VoicePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectedVoice = voices.find((voice) => voice.id === value) ?? voices[0];
  const filteredVoices = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) return voices;

    return voices.filter((voice) =>
      `${voice.label} ${voice.id}`.toLowerCase().includes(normalizedQuery),
    );
  }, [query, voices]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);

    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      cancelBrowserSpeech();
    }
  }, [open]);

  useEffect(() => {
    return () => cancelBrowserSpeech();
  }, []);

  function playSample(voice: Voice) {
    const voiceName = getVoiceName(voice.label);
    void speakTextWithBrowser(
      `Hello, I'm ${voiceName}. This is how I'll read your text.`,
      voice.id,
      { rate: 0, pitch: 0, volume: 0 },
    );
  }

  function selectVoice(voice: Voice) {
    onChange(voice.id);
    setOpen(false);
    setQuery("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const isSearchInput = event.target === inputRef.current;

    if (!open && (event.key === "ArrowDown" || event.key === "Enter")) {
      event.preventDefault();
      setOpen(true);
      return;
    }

    if (!open) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) =>
        Math.min(current + 1, filteredVoices.length - 1),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const voice = filteredVoices[activeIndex];
      if (voice) selectVoice(voice);
    } else if (event.key === " ") {
      if (isSearchInput) return;
      event.preventDefault();
      const voice = filteredVoices[activeIndex];
      if (voice) playSample(voice);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div
      className="voice-picker"
      ref={rootRef}
      onKeyDown={handleKeyDown}
    >
      <button
        className="voice-picker-trigger"
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="voice-picker-flag">
          {getVoiceFlag(selectedVoice.locale ?? selectedVoice.id)}
        </span>
        <span>{selectedVoice.label}</span>
      </button>
      <div className={`voice-picker-popover ${open ? "open" : ""}`}>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search voices..."
          aria-label="Search voices"
        />
        <div className="voice-picker-list" role="listbox">
          {filteredVoices.map((voice, index) => (
            <div
              className={`voice-picker-option ${
                index === activeIndex ? "active" : ""
              }`}
              key={voice.id}
              onClick={() => selectVoice(voice)}
              onMouseEnter={() => {
                setActiveIndex(index);
              }}
              onTouchStart={() => {
                setActiveIndex(index);
              }}
              role="option"
              aria-selected={voice.id === value}
            >
              <span className="voice-picker-flag">
                {getVoiceFlag(voice.locale ?? voice.id)}
              </span>
              <span className="voice-picker-name">{getVoiceName(voice.label)}</span>
              <span className="voice-picker-detail">{voice.label}</span>
              <button
                className="voice-picker-preview"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  playSample(voice);
                }}
                aria-label={`Preview ${getVoiceName(voice.label)}`}
              >
                ▶
              </button>
            </div>
          ))}
          {filteredVoices.length === 0 && (
            <div className="voice-picker-empty">No voices found.</div>
          )}
        </div>
      </div>
    </div>
  );
}
