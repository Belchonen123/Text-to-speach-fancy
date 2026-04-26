"use client";

import {
  useMemo,
  useRef,
  useState,
  useEffect,
  type KeyboardEvent,
} from "react";
import { History, useHistory, type HistoryEntry } from "./components/History";
import { Toast, useToast } from "./components/Toast";
import { VoicePicker } from "./components/VoicePicker";
import {
  configureBrowserUtterance,
  speakTextWithBrowser,
  type BrowserProsody,
} from "./lib/browserSpeech";
import {
  type DialogueSegment,
  estimateDialogueDurationSeconds,
  getDialogueLineCount,
  getDialogueSpeakers,
  parseDialogueScript,
} from "./lib/dialogue";
import {
  DEFAULT_SPEAKER_VOICES,
  VOICES,
  getBrowserVoiceId,
  resolveEdgeVoiceId,
  type Voice,
} from "./lib/voices";

const CHUNK_LENGTH = 4500;

const DEFAULT_PROSODY = {
  rate: 0,
  pitch: 0,
  volume: 0,
};

const DRAFT_STORAGE_KEY = "tts-studio-draft-v1";
const BROWSER_DIALOGUE_LINE_LIMIT = 10;

const SAMPLE_TEXT =
  "Hello! This is a quick test of the text to speech app.";

const DEFAULT_SPEAKERS = Object.keys(DEFAULT_SPEAKER_VOICES);

type ExtractResponse = {
  title?: string;
  content?: string;
  byline?: string;
  error?: string;
};

type ImproveResponse = {
  text?: string;
  error?: string;
};

type ImprovePreview = {
  oldText: string;
  newText: string;
};

type EditorMode = "monologue" | "dialogue";

type StoredDraft = {
  mode: EditorMode;
  text: string;
  voice: string;
  rate: number;
  pitch: number;
  volume: number;
  speakerVoices: Record<string, string>;
  articleByline: string | null;
  savedAt: string;
};

function apiUrl(path: string) {
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).toString();
}

/** Browsers use different TypeError / DOMException messages for the same network failure. */
function networkAwareErrorMessage(err: unknown, actionLabel: string) {
  if (err instanceof Error && err.message) {
    const m = `${err.name} ${err.message}`.toLowerCase();
    if (
      m.includes("failed to fetch") ||
      m.includes("load failed") ||
      m.includes("networkerror") ||
      m.includes("network request failed") ||
      m.includes("ecconnrefused")
    ) {
      return (
        `${actionLabel}: the request never finished. ` +
        `If you develop locally, run npm run dev and open the URL it prints (for example http://localhost:3000). ` +
        `On Vercel and similar hosts, long MP3 jobs can hit a server time limit—try shorter text or raise maxDuration. ` +
        `VPNs and firewalls can also block this app or Microsoft’s TTS endpoint.`
      );
    }
    return err.message;
  }
  return `${actionLabel} failed.`;
}

function getTextStats(value: string) {
  const trimmed = value.trim();
  const words = trimmed.match(/\b[\w'-]+\b/g)?.length ?? 0;
  const lines = trimmed ? trimmed.split(/\n+/).filter(Boolean).length : 0;
  const readingSeconds = Math.max(0, Math.ceil((words / 150) * 60));

  return { words, lines, readingSeconds };
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = String(seconds % 60).padStart(2, "0");

  return `${minutes}:${remainingSeconds}`;
}

export default function Home() {
  const [mode, setMode] = useState<EditorMode>("monologue");
  const [text, setText] = useState(SAMPLE_TEXT);
  const [url, setUrl] = useState("");
  const [extractingUrl, setExtractingUrl] = useState(false);
  const [improvingText, setImprovingText] = useState(false);
  const [improvePreview, setImprovePreview] = useState<ImprovePreview | null>(
    null,
  );
  const [articleByline, setArticleByline] = useState<string | null>(null);
  const [voice, setVoice] = useState(VOICES[0].id);
  const [voiceOptions, setVoiceOptions] = useState<Voice[]>(VOICES);
  const [loading, setLoading] = useState(false);
  const [downloadingMp3, setDownloadingMp3] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [rate, setRate] = useState(DEFAULT_PROSODY.rate);
  const [pitch, setPitch] = useState(DEFAULT_PROSODY.pitch);
  const [volume, setVolume] = useState(DEFAULT_PROSODY.volume);
  const [speakerVoices, setSpeakerVoices] = useState<Record<string, string>>(
    DEFAULT_SPEAKER_VOICES,
  );
  const [savedDraftAt, setSavedDraftAt] = useState<string | null>(null);
  const { toasts, showToast, dismissToast } = useToast();
  const {
    historyEntries,
    deleteHistoryEntry,
    clearHistory,
  } = useHistory();
  const counterTone = text.length > CHUNK_LENGTH ? "accent" : "muted";
  const counterMessage = `${text.length} chars`;
  const dialogueSpeakers = useMemo(() => getDialogueSpeakers(text), [text]);
  const dialogueLineCount = useMemo(() => getDialogueLineCount(text), [text]);
  const dialogueDuration = useMemo(
    () => estimateDialogueDurationSeconds(text),
    [text],
  );
  const textStats = useMemo(() => getTextStats(text), [text]);
  const estimatedDuration =
    mode === "dialogue"
      ? dialogueDuration
      : textStats.readingSeconds;
  const featuredVoiceName = getVoiceLabel(voice).split(" — ")[0];
  const improveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!stored) return;

      const draft = JSON.parse(stored) as StoredDraft;
      setSavedDraftAt(draft.savedAt);
    } catch {
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (improveTimerRef.current) {
        clearTimeout(improveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    function loadBrowserVoices() {
      const browserVoices = window.speechSynthesis.getVoices();
      if (browserVoices.length === 0) return;

      const nextVoices = browserVoices.map((browserVoice) => ({
        id: getBrowserVoiceId(browserVoice),
        label: `${browserVoice.name} — ${browserVoice.lang}`,
        locale: browserVoice.lang,
      }));

      setVoiceOptions(nextVoices);
      setVoice((current) =>
        nextVoices.some((item) => item.id === current)
          ? current
          : nextVoices[0].id,
      );
      setSpeakerVoices((current) => {
        const nextSpeakerVoices = { ...current };

        DEFAULT_SPEAKERS.forEach((speaker, index) => {
          if (nextVoices.some((item) => item.id === nextSpeakerVoices[speaker])) {
            return;
          }

          nextSpeakerVoices[speaker] = nextVoices[index % nextVoices.length].id;
        });

        return nextSpeakerVoices;
      });
    }

    loadBrowserVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadBrowserVoices);

    return () => {
      window.speechSynthesis.removeEventListener(
        "voiceschanged",
        loadBrowserVoices,
      );
    };
  }, []);

  useEffect(() => {
    setSpeakerVoices((current) => {
      const next = { ...current };
      const fallbackVoice = voiceOptions.some((item) => item.id === voice)
        ? voice
        : voiceOptions[0]?.id ?? voice;

      for (const speaker of dialogueSpeakers) {
        const currentVoice = current[speaker];
        const defaultVoice = DEFAULT_SPEAKER_VOICES[speaker];
        const defaultVoiceIsAvailable = voiceOptions.some(
          (item) => item.id === defaultVoice,
        );
        const currentVoiceIsAvailable =
          currentVoice && voiceOptions.some((item) => item.id === currentVoice);

        next[speaker] = currentVoiceIsAvailable
          ? currentVoice
          : defaultVoiceIsAvailable
            ? defaultVoice
            : fallbackVoice;
      }

      return next;
    });
  }, [dialogueSpeakers, voice, voiceOptions]);

  function clearImproveTimer() {
    if (improveTimerRef.current) {
      clearTimeout(improveTimerRef.current);
      improveTimerRef.current = null;
    }
  }

  function commitImprovedText(nextText: string) {
    setText(nextText);
    setArticleByline(null);
    setImprovePreview(null);
    improveTimerRef.current = null;
  }

  async function handleDownloadMp3() {
    if (!text.trim() || downloadingMp3) return;

    const locale = voiceOptions.find((item) => item.id === voice)?.locale ?? null;
    const edgeVoice = resolveEdgeVoiceId(voice, locale);
    const edgeSpeakerVoices =
      mode === "dialogue"
        ? Object.fromEntries(
            Object.entries(speakerVoices).map(([speaker, voiceId]) => {
              const speakerLocale =
                voiceOptions.find((item) => item.id === voiceId)?.locale ?? null;

              return [speaker, resolveEdgeVoiceId(voiceId, speakerLocale)];
            }),
          )
        : undefined;

    setDownloadingMp3(true);

    try {
      const res = await fetch(apiUrl("/api/tts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          text: mode === "monologue" ? text : undefined,
          script: mode === "dialogue" ? text : undefined,
          voice: edgeVoice,
          speakerVoices:
            mode === "dialogue" ? edgeSpeakerVoices : undefined,
          rate,
          pitch,
          volume,
          // Buffered response returns JSON on failure; streaming would abort
          // the body and surface as "Failed to fetch" in the browser.
          responseMode: "buffer",
        }),
      });

      if (!res.ok) {
        let message = "Could not generate MP3.";
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }

      const blob = await res.blob();
      if (blob.size === 0) {
        throw new Error("No audio was returned.");
      }

      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `tts-${Date.now()}.mp3`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);

      showToast({ type: "success", message: "MP3 download started." });
    } catch (e) {
      showToast({
        type: "error",
        message: networkAwareErrorMessage(e, "Download MP3"),
      });
    } finally {
      setDownloadingMp3(false);
    }
  }

  async function handleSpeak() {
    if (!text.trim() || loading) return;
    const requestText = text;
    const requestVoice = voice;
    const requestRate = rate;
    const requestPitch = pitch;
    const requestVolume = volume;

    setLoading(true);
    setGenerationStatus("Speaking…");

    try {
      const spokeInBrowser =
        mode === "dialogue"
          ? await speakDialogueWithBrowser(
              parseDialogueScript(requestText),
              speakerVoices,
              {
                rate: requestRate,
                pitch: requestPitch,
                volume: requestVolume,
              },
            )
          : await speakWithBrowser(
              requestText,
              requestVoice,
              requestRate,
              requestPitch,
              requestVolume,
            );

      if (spokeInBrowser) {
        if (
          mode === "dialogue" &&
          getDialogueLineCount(requestText) > BROWSER_DIALOGUE_LINE_LIMIT
        ) {
          showToast({
            type: "info",
            message: "Browser fallback truncated to first 10 lines.",
          });
        }
      } else {
        showToast({
          type: "error",
          message: "Browser speech is not available in this browser.",
        });
      }
    } finally {
      setLoading(false);
      setGenerationStatus(null);
    }
  }

  async function handleUrlFetch() {
    if (!url.trim() || extractingUrl) return;
    setExtractingUrl(true);

    try {
      const res = await fetch(apiUrl("/api/extract"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await res.json()) as ExtractResponse;

      if (!res.ok) {
        throw new Error(data.error ?? "Could not extract that URL.");
      }

      if (!data.content?.trim()) {
        throw new Error("Could not extract readable content from that page.");
      }

      const nextText = data.title?.trim()
        ? `${data.title.trim()}\n\n${data.content.trim()}`
        : data.content.trim();

      setText(nextText);
      setArticleByline(data.byline?.trim() || null);
      showToast({ type: "success", message: "Article text extracted." });
    } catch (e) {
      showToast({
        type: "error",
        message: networkAwareErrorMessage(e, "Extract URL"),
      });
    } finally {
      setExtractingUrl(false);
    }
  }

  async function handleImproveText() {
    const rawText = text.trim();
    if (!rawText || improvingText) return;

    if (
      rawText.length > 500 &&
      !window.confirm(
        "This will rewrite more than 500 characters. Continue?",
      )
    ) {
      return;
    }

    clearImproveTimer();
    setImprovePreview(null);
    setImprovingText(true);

    try {
      const res = await fetch(apiUrl("/api/improve"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json()) as ImproveResponse;

      if (!res.ok) {
        throw new Error(data.error ?? "Could not improve that text.");
      }

      const improved = data.text?.trim();
      if (!improved) {
        throw new Error("No improved text was returned.");
      }

      if (improved === text.trim()) {
        showToast({ type: "info", message: "Text already sounds ready." });
        return;
      }

      setImprovePreview({ oldText: text, newText: improved });
      improveTimerRef.current = setTimeout(() => {
        commitImprovedText(improved);
        showToast({ type: "success", message: "Improved text applied." });
      }, 3000);
    } catch (e) {
      showToast({
        type: "error",
        message: networkAwareErrorMessage(e, "Improve for audio"),
      });
    } finally {
      setImprovingText(false);
    }
  }

  function handleUndoImprove() {
    clearImproveTimer();
    setImprovePreview(null);
    showToast({ type: "info", message: "Improvement undone." });
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handleSpeak();
    }
  }

  function resetProsody() {
    setRate(DEFAULT_PROSODY.rate);
    setPitch(DEFAULT_PROSODY.pitch);
    setVolume(DEFAULT_PROSODY.volume);
  }

  function handleModeChange(nextMode: EditorMode) {
    if (improvePreview) {
      clearImproveTimer();
      setImprovePreview(null);
    }

    setMode(nextMode);
    if (nextMode === "dialogue") setArticleByline(null);
  }

  async function handleCopyText() {
    if (!text.trim()) return;

    try {
      await navigator.clipboard.writeText(text);
      showToast({ type: "success", message: "Text copied." });
    } catch {
      showToast({ type: "error", message: "Could not copy text." });
    }
  }

  function handleClearText() {
    setText("");
    setArticleByline(null);
    showToast({ type: "info", message: "Editor cleared." });
  }

  function handleSaveDraft() {
    const savedAt = new Date().toISOString();
    const draft: StoredDraft = {
      mode,
      text,
      voice,
      rate,
      pitch,
      volume,
      speakerVoices,
      articleByline,
      savedAt,
    };

    try {
      window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
      setSavedDraftAt(savedAt);
      showToast({ type: "success", message: "Draft saved on this device." });
    } catch {
      showToast({ type: "error", message: "Could not save draft." });
    }
  }

  function formatSavedDraftTime() {
    if (!savedDraftAt) return "No draft saved";

    return `Saved ${new Date(savedDraftAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }

  function formatSignedValue(value: number, suffix: string) {
    return `${value > 0 ? "+" : ""}${value}${suffix}`;
  }

  function speakWithBrowser(
    requestText: string,
    requestVoice: string,
    requestRate: number,
    requestPitch: number,
    requestVolume: number,
  ) {
    return speakTextWithBrowser(requestText, requestVoice, {
      rate: requestRate,
      pitch: requestPitch,
      volume: requestVolume,
    });
  }

  function speakBrowserUtterance(
    utterance: SpeechSynthesisUtterance,
    pauseAfterMs: number,
  ) {
    return new Promise<void>((resolve, reject) => {
      utterance.onend = () => {
        if (pauseAfterMs <= 0) {
          resolve();
          return;
        }

        window.speechSynthesis.pause();
        window.setTimeout(() => {
          window.speechSynthesis.resume();
          resolve();
        }, pauseAfterMs);
      };
      utterance.onerror = () => reject(new Error("Browser speech failed."));
      window.speechSynthesis.speak(utterance);
    });
  }

  async function speakDialogueWithBrowser(
    segments: DialogueSegment[],
    requestSpeakerVoices: Record<string, string>,
    prosody: BrowserProsody,
  ) {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return false;
    }

    const speechSegments = segments.filter((segment) => segment.type === "speech");

    if (speechSegments.length === 0) {
      return false;
    }

    window.speechSynthesis.cancel();

    try {
      let spokenLineCount = 0;

      for (const segment of segments) {
        if (segment.type === "pause") {
          window.speechSynthesis.pause();
          await new Promise<void>((resolve) => {
            window.setTimeout(() => {
              window.speechSynthesis.resume();
              resolve();
            }, segment.pauseMs);
          });
          continue;
        }

        if (spokenLineCount >= BROWSER_DIALOGUE_LINE_LIMIT) {
          break;
        }

        const utterance = new SpeechSynthesisUtterance(segment.text);
        const segmentVoice =
          requestSpeakerVoices[segment.speaker] ??
          DEFAULT_SPEAKER_VOICES[segment.speaker] ??
          voice;

        configureBrowserUtterance(utterance, segmentVoice, prosody);
        await speakBrowserUtterance(utterance, segment.pauseAfterMs);
        spokenLineCount += 1;
      }

      return true;
    } catch {
      return false;
    }
  }

  function getVoiceLabel(voiceId: string) {
    return (
      voiceOptions.find((item) => item.id === voiceId)?.label ??
      VOICES.find((item) => item.id === voiceId)?.label ??
      voiceId
    );
  }

  function handleHistorySelect(entry: HistoryEntry) {
    setText(entry.text);
    setVoice(entry.voice);
  }

  return (
    <>
      <History
        entries={historyEntries}
        getVoiceLabel={getVoiceLabel}
        onSelect={handleHistorySelect}
        onDelete={deleteHistoryEntry}
        onClear={clearHistory}
      />
      <main>
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">Free TTS Studio</div>
            <h1>
              Words, given <em>voice</em>.
            </h1>
            <p className="subtitle">
              Type anything below and hear it read aloud in natural, expressive
              speech, powered by your browser's built-in voices. No API keys. No
              pricing.
            </p>
            <div className="hero-pills" aria-label="Studio features">
              <span>Browser voices</span>
              <span>Dialogue mode</span>
              <span>Instant playback</span>
            </div>
          </div>
          <div className="sonic-card" aria-hidden="true">
            <div className="sonic-orb" />
            <div className="preview-kicker">Now voicing</div>
            <div className="preview-voice">{featuredVoiceName}</div>
            <div className="sonic-bars">
              {Array.from({ length: 18 }, (_, index) => (
                <span key={index} />
              ))}
            </div>
            <div className="sonic-caption">
              <span>Live voice render</span>
              <strong>{loading ? "Speaking" : "Ready"}</strong>
            </div>
          </div>
        </section>

        <div className="studio-stats" aria-label="Current studio stats">
          <div>
            <span>Mode</span>
            <strong>{mode}</strong>
          </div>
          <div>
            <span>Words</span>
            <strong>{textStats.words}</strong>
          </div>
          <div>
            <span>{mode === "dialogue" ? "Dialogue time" : "Read time"}</span>
            <strong>~{formatDuration(estimatedDuration)}</strong>
          </div>
          <div>
            <span>{mode === "dialogue" ? "Speakers" : "Voice"}</span>
            <strong>
              {mode === "dialogue"
                ? dialogueSpeakers.length || 2
                : featuredVoiceName}
            </strong>
          </div>
        </div>

      <div className="editor">
        <div className="mode-toggle" aria-label="Editor mode">
          <button
            type="button"
            className={mode === "monologue" ? "active" : ""}
            aria-pressed={mode === "monologue"}
            onPointerDown={() => handleModeChange("monologue")}
            onClick={() => handleModeChange("monologue")}
          >
            Monologue
          </button>
          <button
            type="button"
            className={mode === "dialogue" ? "active" : ""}
            aria-pressed={mode === "dialogue"}
            onPointerDown={() => handleModeChange("dialogue")}
            onClick={() => handleModeChange("dialogue")}
          >
            Dialogue
          </button>
        </div>
        {mode === "monologue" && (
          <div className="url-fetcher">
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleUrlFetch();
                }
              }}
              placeholder="Or paste a URL…"
              aria-label="Article URL"
            />
            <button
              type="button"
              onClick={handleUrlFetch}
              disabled={extractingUrl || !url.trim()}
            >
              {extractingUrl ? "Fetching" : "Fetch"}
            </button>
          </div>
        )}
        <div className="feature-panel">
          <div className="toolkit-row" aria-label="Editor tools">
            <div className="mini-stats">
              <span>{textStats.words} words</span>
              <span>{textStats.lines} lines</span>
              <span>~{formatDuration(textStats.readingSeconds)} read</span>
            </div>
            <div className="tool-buttons">
              <button type="button" onClick={handleCopyText} disabled={!text.trim()}>
                Copy
              </button>
              <button type="button" onClick={handleSaveDraft} disabled={!text.trim()}>
                Save draft
              </button>
              <button type="button" onClick={handleClearText} disabled={!text}>
                Clear
              </button>
            </div>
            <span className="draft-status">{formatSavedDraftTime()}</span>
          </div>
        </div>
        <div className="textarea-wrap">
          {mode === "monologue" && articleByline && (
            <div className="article-byline">{articleByline}</div>
          )}
          {mode === "dialogue" && (
            <div className="script-stats">
              <span>
                {dialogueLineCount} {dialogueLineCount === 1 ? "line" : "lines"}
              </span>
              <span>~{formatDuration(dialogueDuration)}</span>
            </div>
          )}
          {improvePreview && (
            <div className="improve-diff" role="status">
              <div className="improve-diff-header">
                <span>Applying improved version</span>
                <button type="button" onClick={handleUndoImprove}>
                  Undo
                </button>
              </div>
              <div className="improve-diff-body">
                <del>{improvePreview.oldText}</del>
                <mark>{improvePreview.newText}</mark>
              </div>
            </div>
          )}
          <textarea
            value={text}
            onChange={(e) => {
              if (improvePreview) {
                clearImproveTimer();
                setImprovePreview(null);
              }
              setText(e.target.value);
              if (!e.target.value.trim()) setArticleByline(null);
            }}
            onKeyDown={handleTextareaKeyDown}
            placeholder={
              mode === "dialogue"
                ? "Ava: So what did you think of the proposal?\nBrian: Honestly? It needs work."
                : "Start typing, or paste a passage you want read aloud…"
            }
          />
          <div className="textarea-meta">
            {!text && <div className="shortcut-hint">⌘⏎ to speak</div>}
            <div className={`char-counter ${counterTone}`}>{counterMessage}</div>
          </div>
        </div>
        {mode === "dialogue" && (
          <div className="voice-legend">
            <div className="voice-legend-label">Voice legend</div>
            <div className="voice-chips">
              {(dialogueSpeakers.length ? dialogueSpeakers : ["Ava", "Brian"]).map(
                (speakerName) => (
                  <label className="voice-chip" key={speakerName}>
                    <span>{speakerName}</span>
                    <select
                      value={
                        speakerVoices[speakerName] ??
                        DEFAULT_SPEAKER_VOICES[speakerName] ??
                        voice
                      }
                      onChange={(event) =>
                        setSpeakerVoices((current) => ({
                          ...current,
                          [speakerName]: event.target.value,
                        }))
                      }
                    >
                      {voiceOptions.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ),
              )}
            </div>
          </div>
        )}
        <div className="controls">
          <div className="control-panel">
            <div className="voice-control-row">
              <VoicePicker
                voices={voiceOptions}
                value={voice}
                onChange={setVoice}
              />
              <button
                className="improve-button"
                type="button"
                onClick={handleImproveText}
                disabled={!text.trim() || improvingText || Boolean(improvePreview)}
              >
                {improvingText ? "Improving" : "Improve for audio"}
              </button>
            </div>
            <button
              className="advanced-toggle"
              type="button"
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-expanded={advancedOpen}
            >
              Advanced
            </button>
            {advancedOpen && (
              <div className="advanced-panel">
                <div className="advanced-header">
                  <div>SSML Controls</div>
                  <button type="button" onClick={resetProsody}>
                    Reset
                  </button>
                </div>
                <label className="slider-row">
                  <span>Rate</span>
                  <input
                    type="range"
                    min="-50"
                    max="50"
                    value={rate}
                    onChange={(e) => setRate(Number(e.target.value))}
                  />
                  <span className="slider-value">
                    {formatSignedValue(rate, "%")}
                  </span>
                </label>
                <label className="slider-row">
                  <span>Pitch</span>
                  <input
                    type="range"
                    min="-10"
                    max="10"
                    value={pitch}
                    onChange={(e) => setPitch(Number(e.target.value))}
                  />
                  <span className="slider-value">
                    {formatSignedValue(pitch, "st")}
                  </span>
                </label>
                <label className="slider-row">
                  <span>Volume</span>
                  <input
                    type="range"
                    min="-50"
                    max="50"
                    value={volume}
                    onChange={(e) => setVolume(Number(e.target.value))}
                  />
                  <span className="slider-value">
                    {formatSignedValue(volume, "%")}
                  </span>
                </label>
              </div>
            )}
          </div>
          <div className="speak-actions">
            <button
              className="speak ghost"
              type="button"
              onClick={() => void handleDownloadMp3()}
              disabled={!text.trim() || downloadingMp3 || loading}
              aria-busy={downloadingMp3}
            >
              {downloadingMp3 ? "Preparing MP3…" : "Download MP3"}
            </button>
            <button
              className="speak"
              type="button"
              onClick={handleSpeak}
              disabled={loading || !text.trim()}
              aria-label={loading ? "Speaking" : undefined}
              aria-busy={loading}
              title={!text.trim() ? "Enter text to enable Speak" : undefined}
            >
              {loading ? generationStatus ?? "Speaking…" : "Speak"}
              {!loading && (
                <span className="arrow" aria-hidden>
                  →
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      <Toast toasts={toasts} onDismiss={dismissToast} />

        <div className="footer-note">
          <strong>Speak</strong> uses your browser voices. <strong>Download MP3</strong> uses Microsoft Edge neural voices on the server (mapped from your selected language). If MP3 fails, your network may block the Edge TTS service.
        </div>
      </main>
    </>
  );
}
