# Code Review Export

Generated from project source files. Excludes `.env*`, `.next`, `node_modules`, `public` audio assets, and lock/generated artifacts.

## package.json

```json
{
  "name": "tts-app",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.91.1",
    "@mozilla/readability": "^0.6.0",
    "@vercel/blob": "^2.3.3",
    "jsdom": "^29.0.2",
    "msedge-tts": "^1.3.4",
    "next": "14.2.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/jsdom": "^28.0.1",
    "@types/node": "^20",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "tsx": "^4.21.0",
    "typescript": "^5"
  }
}

```

## next.config.mjs

```js
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;

```

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}

```

## app\layout.tsx

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Free TTS Studio",
  description: "Text to speech, free forever â€” powered by Edge neural voices.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

```

## app\page.tsx

```tsx
"use client";

/*
Streaming playback design:
- We use MediaSource for browsers that can append `audio/mpeg` chunks. It lets
  the custom player start from a generated object URL while the fetch body is
  still receiving MP3 frames from the server.
- MP3 frames can be appended sequentially, so the API streams each TTS segment
  as raw MP3 bytes and the client feeds those bytes into one SourceBuffer.
- Safari on iOS does not reliably support MediaSource for MP3, so the fallback
  keeps the previous behavior: collect the stream into a Blob, then play the
  completed object URL.
*/

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
import { Waveform } from "./components/Waveform";
import {
  estimateDialogueDurationSeconds,
  getDialogueLineCount,
  getDialogueSpeakers,
  parseDialogueScript,
} from "./lib/dialogue";
import {
  DEFAULT_SPEAKER_VOICES,
  getVoiceLocale,
  VOICES,
} from "./lib/voices";

const CHUNK_LENGTH = 4500;

const DEFAULT_PROSODY = {
  rate: 0,
  pitch: 0,
  volume: 0,
};

const DRAFT_STORAGE_KEY = "tts-studio-draft-v1";

const SAMPLE_TEXT =
  "Hello! This is a quick test of the text to speech app.";

const SCRIPT_PRESETS: Array<{
  label: string;
  mode: EditorMode;
  text: string;
}> = [
  {
    label: "Podcast intro",
    mode: "dialogue",
    text: "Ava: Welcome back to the show. Today we are unpacking one practical idea you can use right away.\nBrian: And we will keep it simple, useful, and under five minutes.",
  },
  {
    label: "Product demo",
    mode: "monologue",
    text: "Meet your new voice workflow. Paste a draft, choose a voice, tune the delivery, and export a polished MP3 in seconds.",
  },
  {
    label: "Support reply",
    mode: "monologue",
    text: "Thanks for reaching out. I took a look at your request, and here is the quickest way to get everything working again.",
  },
  {
    label: "Story scene",
    mode: "dialogue",
    text: "Emma: The lighthouse flickered once, then went dark.\nRyan: That means someone is already on the island.",
  },
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function revokeAudioUrl(url: string | null) {
  if (url?.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Could not read generated audio."));
      }
    };
    reader.onerror = () => reject(new Error("Could not read generated audio."));
    reader.readAsDataURL(blob);
  });
}

function splitIntoSentences(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  const matches = normalized.match(/.*?(?:[.!?](?=\s|$)|$)/g) ?? [];

  return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

function getChunkCount(value: string) {
  const sentences = splitIntoSentences(value);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;

    if (next.length <= CHUNK_LENGTH) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    current = sentence;
  }

  if (current) {
    chunks.push(current);
  }

  return Math.max(chunks.length, value.trim() ? 1 : 0);
}

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

type ShareResponse = {
  id?: string;
  url?: string;
  warning?: string;
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

function getTextStats(value: string) {
  const trimmed = value.trim();
  const words = trimmed.match(/\b[\w'-]+\b/g)?.length ?? 0;
  const lines = trimmed ? trimmed.split(/\n+/).filter(Boolean).length : 0;
  const readingSeconds = Math.max(0, Math.ceil((words / 150) * 60));

  return { words, lines, readingSeconds };
}

function cleanEditorText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = String(seconds % 60).padStart(2, "0");

  return `${minutes}:${remainingSeconds}`;
}

function supportsMediaSourceStreaming() {
  return (
    typeof window !== "undefined" &&
    "MediaSource" in window &&
    MediaSource.isTypeSupported("audio/mpeg")
  );
}

function waitForSourceOpen(mediaSource: MediaSource) {
  return new Promise<void>((resolve, reject) => {
    if (mediaSource.readyState === "open") {
      resolve();
      return;
    }

    mediaSource.addEventListener("sourceopen", () => resolve(), { once: true });
    mediaSource.addEventListener(
      "sourceended",
      () => reject(new Error("Media source ended before opening.")),
      { once: true },
    );
  });
}

function appendSourceBuffer(
  sourceBuffer: SourceBuffer,
  chunk: Uint8Array<ArrayBuffer>,
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", handleUpdateEnd);
      sourceBuffer.removeEventListener("error", handleError);
    };
    const handleUpdateEnd = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Could not append streamed audio."));
    };

    sourceBuffer.addEventListener("updateend", handleUpdateEnd, { once: true });
    sourceBuffer.addEventListener("error", handleError, { once: true });
    sourceBuffer.appendBuffer(chunk.buffer.slice(0));
  });
}

function normalizeChunk(chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new ArrayBuffer(chunk.byteLength);
  const view = new Uint8Array(copy);
  view.set(chunk);

  return view;
}

function chunksToBlob(chunks: Uint8Array<ArrayBuffer>[]) {
  const parts = chunks.map((chunk) => chunk.buffer.slice(0));

  return new Blob(parts, { type: "audio/mpeg" });
}

function getBrowserSpeechText(mode: EditorMode, value: string) {
  if (mode === "monologue") {
    return value;
  }

  return parseDialogueScript(value)
    .map((segment) => {
      if (segment.type === "pause") {
        return "\n";
      }

      return segment.text;
    })
    .join("\n")
    .trim();
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
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [currentAudioBase64, setCurrentAudioBase64] = useState<string | null>(
    null,
  );
  const [ttsProviderOffline, setTtsProviderOffline] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [streaming, setStreaming] = useState(false);
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
    addHistoryEntry,
    deleteHistoryEntry,
    clearHistory,
  } = useHistory();
  const chunkCount = getChunkCount(text);
  const counterTone = text.length > CHUNK_LENGTH ? "accent" : "muted";
  const counterMessage = `${text.length} chars`;
  const chunkPreview =
    text.length > CHUNK_LENGTH
      ? `Will generate in ${chunkCount} ${chunkCount === 1 ? "part" : "parts"}`
      : null;
  const dialogueSpeakers = useMemo(() => getDialogueSpeakers(text), [text]);
  const dialogueLineCount = useMemo(() => getDialogueLineCount(text), [text]);
  const dialogueDuration = useMemo(
    () => estimateDialogueDurationSeconds(text),
    [text],
  );
  const wordCount = useMemo(
    () => (text.trim() ? text.trim().split(/\s+/).length : 0),
    [text],
  );
  const estimatedDuration =
    mode === "dialogue"
      ? dialogueDuration
      : Math.max(0, Math.round((wordCount / 155) * 60));
  const featuredVoiceName = getVoiceLabel(voice).split(" â€” ")[0];
  const textStats = useMemo(() => getTextStats(text), [text]);
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

  // Clean up blob URLs when they're replaced
  useEffect(() => {
    return () => {
      revokeAudioUrl(audioUrl);
      revokeAudioUrl(downloadUrl);
    };
  }, [audioUrl, downloadUrl]);

  useEffect(() => {
    setSpeakerVoices((current) => {
      const next = { ...current };

      for (const speaker of dialogueSpeakers) {
        next[speaker] =
          current[speaker] ?? DEFAULT_SPEAKER_VOICES[speaker] ?? voice;
      }

      return next;
    });
  }, [dialogueSpeakers, voice]);

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

  async function handleSpeak() {
    if (!text.trim() || loading) return;
    const requestText = text;
    const requestVoice = voice;
    const requestRate = rate;
    const requestPitch = pitch;
    const requestVolume = volume;
    let transientAudioUrl: string | null = null;

    if (ttsProviderOffline) {
      const spokeInBrowser = speakWithBrowser(
        getBrowserSpeechText(mode, requestText),
        requestVoice,
        requestRate,
        requestPitch,
        requestVolume,
      );

      showToast({
        type: spokeInBrowser ? "info" : "error",
        message: spokeInBrowser
          ? "Using your browser voice because the MP3 generator is offline."
          : "Your browser could not start speech playback.",
      });
      return;
    }

    setLoading(true);
    setStreaming(false);
    setGenerationStatus("Preparing streamâ€¦");

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          text: mode === "monologue" ? requestText : undefined,
          script: mode === "dialogue" ? requestText : undefined,
          voice: requestVoice,
          speakerVoices: mode === "dialogue" ? speakerVoices : undefined,
          rate: requestRate,
          pitch: requestPitch,
          volume: requestVolume,
        }),
      });

      if (!res.ok) {
        let message = "Something went wrong generating that.";
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
        } catch {
          /* fall through */
        }
        throw new Error(message);
      }

      if (!res.body) {
        throw new Error("No audio stream returned.");
      }

      const reader = res.body.getReader();
      const receivedChunks: Uint8Array<ArrayBuffer>[] = [];
      let blob: Blob;

      revokeAudioUrl(audioUrl);
      revokeAudioUrl(downloadUrl);
      setDownloadUrl(null);
      setCurrentAudioBase64(null);

      if (supportsMediaSourceStreaming()) {
        const mediaSource = new MediaSource();
        const mediaUrl = URL.createObjectURL(mediaSource);
        transientAudioUrl = mediaUrl;
        setAudioUrl(mediaUrl);
        await waitForSourceOpen(mediaSource);

        const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
        try {
          sourceBuffer.mode = "sequence";
        } catch {
          /* Some browsers expose mode as read-only for this codec. */
        }

        setGenerationStatus("Streaming audioâ€¦");

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          const chunk = normalizeChunk(value);
          setStreaming(true);
          receivedChunks.push(chunk);
          await appendSourceBuffer(sourceBuffer, chunk);
        }

        if (sourceBuffer.updating) {
          await new Promise<void>((resolve) => {
            sourceBuffer.addEventListener("updateend", () => resolve(), {
              once: true,
            });
          });
        }

        if (mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }

        blob = chunksToBlob(receivedChunks);
        const completedDownloadUrl = URL.createObjectURL(blob);
        setDownloadUrl(completedDownloadUrl);
        transientAudioUrl = null;
      } else {
        setGenerationStatus("Generating audioâ€¦");

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          const chunk = normalizeChunk(value);
          setStreaming(true);
          receivedChunks.push(chunk);
        }

        blob = chunksToBlob(receivedChunks);
        const completedUrl = URL.createObjectURL(blob);
        setAudioUrl(completedUrl);
        setDownloadUrl(completedUrl);
      }

      if (receivedChunks.length === 0) {
        throw new Error("TTS generation finished without audio.");
      }

      try {
        const historyAudio = await blobToBase64(blob);
        setCurrentAudioBase64(historyAudio);
        const stored = addHistoryEntry({
          text: requestText,
          voice: requestVoice,
          audioBase64: historyAudio,
        });

        if (!stored) {
          showToast({
            type: "info",
            message: "That audio was too large to save in history.",
          });
        }
      } catch {
        showToast({
          type: "info",
          message: "Generated audio could not be saved in history.",
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Request failed.";
      const browserSpeechText = getBrowserSpeechText(mode, requestText);
      setTtsProviderOffline(true);

      if (transientAudioUrl) {
        revokeAudioUrl(transientAudioUrl);
        setAudioUrl(null);
        transientAudioUrl = null;
      }

      const spokeInBrowser = speakWithBrowser(
        browserSpeechText,
        requestVoice,
        requestRate,
        requestPitch,
        requestVolume,
      );

      if (spokeInBrowser) {
        showToast({
          type: "info",
          message:
            "Using your browser voice because the MP3 generator could not connect.",
        });
      } else {
        showToast({ type: "error", message });
      }
    } finally {
      setLoading(false);
      setStreaming(false);
      setGenerationStatus(null);
    }
  }

  async function handleUrlFetch() {
    if (!url.trim() || extractingUrl) return;
    setExtractingUrl(true);

    try {
      const res = await fetch("/api/extract", {
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
      const message = e instanceof Error ? e.message : "Extraction failed.";
      showToast({ type: "error", message });
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
      const res = await fetch("/api/improve", {
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
      const message = e instanceof Error ? e.message : "Could not improve text.";
      showToast({ type: "error", message });
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

  function applyDraft(draft: StoredDraft) {
    setMode(draft.mode);
    setText(draft.text);
    setVoice(draft.voice);
    setRate(draft.rate);
    setPitch(draft.pitch);
    setVolume(draft.volume);
    setSpeakerVoices(draft.speakerVoices);
    setArticleByline(draft.articleByline);
    setSavedDraftAt(draft.savedAt);
  }

  function handlePresetSelect(preset: (typeof SCRIPT_PRESETS)[number]) {
    setMode(preset.mode);
    setText(preset.text);
    setArticleByline(null);
    showToast({ type: "success", message: `${preset.label} loaded.` });
  }

  function handleModeChange(nextMode: EditorMode) {
    if (improvePreview) {
      clearImproveTimer();
      setImprovePreview(null);
    }

    setMode(nextMode);
    if (nextMode === "dialogue") setArticleByline(null);
  }

  function handleCleanText() {
    const cleaned = cleanEditorText(text);
    setText(cleaned);
    if (!cleaned) setArticleByline(null);
    showToast({ type: "success", message: "Text cleaned up." });
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

  function handleLoadDraft() {
    try {
      const stored = window.localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!stored) {
        showToast({ type: "info", message: "No saved draft yet." });
        return;
      }

      applyDraft(JSON.parse(stored) as StoredDraft);
      showToast({ type: "success", message: "Draft restored." });
    } catch {
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
      setSavedDraftAt(null);
      showToast({ type: "error", message: "Saved draft was not readable." });
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
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return false;
    }

    const locale = getVoiceLocale(requestVoice);
    const utterance = new SpeechSynthesisUtterance(requestText);
    const voices = window.speechSynthesis.getVoices();
    const browserVoice =
      voices.find((item) => item.lang.toLowerCase() === locale.toLowerCase()) ??
      voices.find((item) =>
        item.lang.toLowerCase().startsWith(locale.slice(0, 2).toLowerCase()),
      );

    utterance.lang = browserVoice?.lang ?? locale;
    utterance.voice = browserVoice ?? null;
    utterance.rate = clamp(1 + requestRate / 100, 0.1, 2);
    utterance.pitch = clamp(1 + requestPitch / 10, 0, 2);
    utterance.volume = clamp(1 + requestVolume / 100, 0, 1);

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    window.speechSynthesis.resume();
    return true;
  }

  function getDownloadFilename() {
    const slug =
      text
        .toLowerCase()
        .match(/[a-z0-9]+/g)
        ?.slice(0, 3)
        .join("-") || "audio";

    return `tts-${slug}-${Date.now()}.mp3`;
  }

  function getVoiceLabel(voiceId: string) {
    return VOICES.find((item) => item.id === voiceId)?.label ?? voiceId;
  }

  function handleHistorySelect(entry: HistoryEntry) {
    revokeAudioUrl(audioUrl);
    revokeAudioUrl(downloadUrl);
    setText(entry.text);
    setVoice(entry.voice);
    setAudioUrl(entry.audioBase64);
    setDownloadUrl(entry.audioBase64);
    setCurrentAudioBase64(entry.audioBase64);
  }

  async function getShareAudioBase64() {
    if (currentAudioBase64) return currentAudioBase64;

    const href = downloadUrl ?? audioUrl;
    if (!href) return null;

    const response = await fetch(href);
    const blob = await response.blob();
    const audioBase64 = await blobToBase64(blob);
    setCurrentAudioBase64(audioBase64);

    return audioBase64;
  }

  async function handleShare() {
    if (sharing) return;
    setSharing(true);

    try {
      const audioBase64 = await getShareAudioBase64();
      if (!audioBase64) {
        throw new Error("Generate audio before sharing.");
      }

      const response = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioBase64, text, voice }),
      });
      const data = (await response.json()) as ShareResponse;

      if (!response.ok || !data.url) {
        throw new Error(data.error ?? "Could not create share link.");
      }

      await navigator.clipboard.writeText(data.url);
      showToast({
        type: data.warning ? "info" : "success",
        message: data.warning ?? "Share link copied.",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not share audio.";
      showToast({ type: "error", message });
    } finally {
      setSharing(false);
    }
  }

  function handleDownload() {
    const href = downloadUrl ?? audioUrl;
    if (!href) return;

    const link = document.createElement("a");
    link.href = href;
    link.download = getDownloadFilename();
    document.body.appendChild(link);
    link.click();
    link.remove();
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
              speech, powered by Microsoft Edge neural voices. No API keys. No
              pricing. No limits.
            </p>
            <div className="hero-pills" aria-label="Studio features">
              <span>Neural voices</span>
              <span>Dialogue mode</span>
              <span>Waveform preview</span>
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
              <strong>{loading ? "Generating" : "Ready"}</strong>
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
            <strong>{wordCount}</strong>
          </div>
          <div>
            <span>Runtime</span>
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
              placeholder="Or paste a URLâ€¦"
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
          <div className="preset-row" aria-label="Script presets">
            <span>Presets</span>
            {SCRIPT_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => handlePresetSelect(preset)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="toolkit-row" aria-label="Editor tools">
            <div className="mini-stats">
              <span>{textStats.words} words</span>
              <span>{textStats.lines} lines</span>
              <span>~{formatDuration(textStats.readingSeconds)} read</span>
            </div>
            <div className="tool-buttons">
              <button type="button" onClick={handleCleanText} disabled={!text}>
                Clean
              </button>
              <button type="button" onClick={handleCopyText} disabled={!text.trim()}>
                Copy
              </button>
              <button type="button" onClick={handleSaveDraft} disabled={!text.trim()}>
                Save draft
              </button>
              <button type="button" onClick={handleLoadDraft}>
                Load draft
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
                : "Start typing, or paste a passage you want read aloudâ€¦"
            }
          />
          <div className="textarea-meta">
            {!text && <div className="shortcut-hint">âŒ˜âŽ to generate</div>}
            {mode === "monologue" && chunkPreview && (
              <div className="chunk-preview">{chunkPreview}</div>
            )}
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
                      {VOICES.map((item) => (
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
                voices={VOICES}
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
          <button
            className="speak"
            onClick={handleSpeak}
            disabled={loading || !text.trim()}
            aria-label={loading ? "Generating speech" : undefined}
            title={!text.trim() ? "Enter text to enable Speak" : undefined}
          >
            {loading ? generationStatus ?? "Generatingâ€¦" : "Speak"}
            {!loading && (
              <span className="arrow" aria-hidden>
                â†’
              </span>
            )}
          </button>
        </div>
      </div>

      {audioUrl && (
        <div className="player">
          <div className="player-heading">
            <div className="player-label">Output</div>
            {streaming && <div className="streaming-badge">Streaming</div>}
          </div>
          <div className="player-row">
            <Waveform src={audioUrl} autoPlay />
            <button
              className="speak ghost"
              onClick={handleShare}
              disabled={sharing || streaming || loading}
            >
              {sharing ? "Sharing" : "Share"}
            </button>
            <button className="speak ghost" onClick={handleDownload}>
              <svg
                aria-hidden
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 3v12" />
                <path d="m7 10 5 5 5-5" />
                <path d="M5 21h14" />
              </svg>
              Download MP3
            </button>
          </div>
        </div>
      )}

      <Toast toasts={toasts} onDismiss={dismissToast} />

        <div className="footer-note">
          Want more voices? Edge TTS supports <strong>300+ voices across 100+ languages</strong>. Edit the <code>VOICES</code> array in <code>app/page.tsx</code>. To see the full list, run <code>npx edge-tts --list-voices</code> in your terminal.
        </div>
      </main>
    </>
  );
}

```

## app\globals.css

```css
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400;1,9..144,500&family=Manrope:wght@400;500;600;700&display=swap');

:root {
  --bg: #090a12;
  --paper: rgba(16, 19, 35, 0.78);
  --paper-strong: rgba(25, 30, 54, 0.88);
  --ink: #f6f1ff;
  --ink-muted: #a7aac6;
  --accent: #7cf7ff;
  --accent-dark: #3dd0ff;
  --hot: #ff5fcb;
  --warning: #ff8663;
  --success: #7dffae;
  --border: rgba(171, 181, 255, 0.18);
  --error-bg: rgba(255, 134, 99, 0.14);
  --error-ink: #ffb199;
  --glow: 0 0 32px rgba(124, 247, 255, 0.28);
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html,
body {
  background:
    radial-gradient(circle at 18% 12%, rgba(124, 247, 255, 0.2), transparent 28rem),
    radial-gradient(circle at 82% 4%, rgba(255, 95, 203, 0.18), transparent 30rem),
    radial-gradient(circle at 50% 100%, rgba(105, 93, 255, 0.18), transparent 32rem),
    var(--bg);
  color: var(--ink);
  font-family: 'Manrope', system-ui, sans-serif;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: 0.22;
  z-index: 1;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='4'/><feColorMatrix values='0 0 0 0 0.7 0 0 0 0 0.8 0 0 0 0 1 0 0 0 0.07 0'/></filter><rect width='200' height='200' filter='url(%23n)'/></svg>");
  background-size: 72px 72px, 72px 72px, 200px 200px;
  mask-image: linear-gradient(to bottom, black, transparent 78%);
}

body::after {
  content: '';
  position: fixed;
  inset: auto 12% 7% auto;
  width: 280px;
  height: 280px;
  border-radius: 999px;
  background: rgba(124, 247, 255, 0.08);
  filter: blur(18px);
  pointer-events: none;
  z-index: 1;
  animation: pulse-orb 7s ease-in-out infinite;
}

html::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    linear-gradient(115deg, transparent 0 42%, rgba(124, 247, 255, 0.07) 42.2% 42.6%, transparent 42.8%),
    linear-gradient(70deg, transparent 0 58%, rgba(255, 95, 203, 0.06) 58.2% 58.6%, transparent 58.8%);
}

main {
  position: relative;
  z-index: 2;
  max-width: 1040px;
  margin: 0 auto;
  padding: 72px 32px 120px;
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(280px, 0.9fr);
  align-items: center;
  gap: 44px;
  margin-bottom: 28px;
}

.hero-copy {
  min-width: 0;
}

.eyebrow {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 20px;
  display: flex;
  align-items: center;
  gap: 12px;
  text-shadow: 0 0 18px rgba(124, 247, 255, 0.5);
}

.eyebrow::before {
  content: '';
  width: 28px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent));
}

h1 {
  position: relative;
  font-family: 'Fraunces', Georgia, serif;
  font-weight: 400;
  font-size: clamp(56px, 9vw, 104px);
  line-height: 0.9;
  letter-spacing: -0.025em;
  margin-bottom: 20px;
  font-variation-settings: "SOFT" 50, "opsz" 144;
}

h1::after {
  content: '';
  position: absolute;
  right: min(18%, 140px);
  top: -14px;
  width: 58px;
  height: 58px;
  background:
    linear-gradient(var(--accent), var(--accent)) 50% 0 / 1px 100% no-repeat,
    linear-gradient(90deg, var(--hot), var(--accent)) 0 50% / 100% 1px no-repeat;
  filter: drop-shadow(0 0 16px rgba(124, 247, 255, 0.65));
  opacity: 0.72;
  transform: rotate(18deg);
}

h1 em {
  font-style: italic;
  color: transparent;
  background: linear-gradient(110deg, var(--accent), var(--hot) 60%, #fff0a8);
  background-clip: text;
  -webkit-background-clip: text;
  font-weight: 400;
}

.subtitle {
  font-size: 17px;
  color: var(--ink-muted);
  max-width: 520px;
  line-height: 1.55;
  margin-bottom: 24px;
}

.hero-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.hero-pills span {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--ink);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  padding: 10px 13px;
  text-transform: uppercase;
  box-shadow: 0 0 22px rgba(124, 247, 255, 0.06) inset;
}

.sonic-card {
  position: relative;
  min-height: 360px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 32px;
  background:
    linear-gradient(145deg, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.035)),
    radial-gradient(circle at 50% 32%, rgba(124, 247, 255, 0.28), transparent 13rem),
    var(--paper);
  box-shadow:
    var(--glow),
    0 34px 100px -48px rgba(0, 0, 0, 0.82),
    inset 0 1px 0 rgba(255, 255, 255, 0.18);
  backdrop-filter: blur(24px);
}

.sonic-card::before,
.sonic-card::after {
  content: '';
  position: absolute;
  border: 1px solid rgba(124, 247, 255, 0.26);
  border-radius: 999px;
  inset: 42px;
  animation: sonic-ring 5s linear infinite;
}

.sonic-card::after {
  inset: 82px;
  border-color: rgba(255, 95, 203, 0.24);
  animation-duration: 7s;
  animation-direction: reverse;
}

.sonic-orb {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 142px;
  height: 142px;
  border-radius: 999px;
  background:
    radial-gradient(circle at 35% 30%, #ffffff, var(--accent) 22%, #695dff 56%, var(--hot));
  box-shadow:
    0 0 38px rgba(124, 247, 255, 0.58),
    0 0 86px rgba(255, 95, 203, 0.28);
  transform: translate(-50%, -50%);
  animation: float-orb 5s ease-in-out infinite;
}

.preview-kicker,
.preview-voice {
  position: relative;
  z-index: 1;
}

.preview-kicker {
  margin: 30px 28px 0;
  color: var(--ink-muted);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

.preview-voice {
  max-width: 210px;
  margin: 8px 28px 0;
  font-family: 'Fraunces', Georgia, serif;
  font-size: clamp(38px, 5vw, 58px);
  line-height: 0.92;
  letter-spacing: -0.045em;
  text-shadow: 0 0 28px rgba(124, 247, 255, 0.22);
}

.sonic-bars {
  position: absolute;
  right: 28px;
  bottom: 84px;
  left: 28px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 7px;
  height: 84px;
}

.sonic-bars span {
  width: 8px;
  min-height: 16px;
  border-radius: 999px;
  background: linear-gradient(to top, var(--hot), var(--accent));
  box-shadow: 0 0 18px rgba(124, 247, 255, 0.42);
  animation: equalize 1.3s ease-in-out infinite;
  animation-delay: calc(var(--bar-index, 0) * 60ms);
}

.sonic-bars span:nth-child(1) { --bar-index: 1; height: 34%; }
.sonic-bars span:nth-child(2) { --bar-index: 2; height: 72%; }
.sonic-bars span:nth-child(3) { --bar-index: 3; height: 44%; }
.sonic-bars span:nth-child(4) { --bar-index: 4; height: 88%; }
.sonic-bars span:nth-child(5) { --bar-index: 5; height: 58%; }
.sonic-bars span:nth-child(6) { --bar-index: 6; height: 78%; }
.sonic-bars span:nth-child(7) { --bar-index: 7; height: 48%; }
.sonic-bars span:nth-child(8) { --bar-index: 8; height: 94%; }
.sonic-bars span:nth-child(9) { --bar-index: 9; height: 64%; }
.sonic-bars span:nth-child(10) { --bar-index: 10; height: 82%; }
.sonic-bars span:nth-child(11) { --bar-index: 11; height: 52%; }
.sonic-bars span:nth-child(12) { --bar-index: 12; height: 74%; }
.sonic-bars span:nth-child(13) { --bar-index: 13; height: 38%; }
.sonic-bars span:nth-child(14) { --bar-index: 14; height: 68%; }
.sonic-bars span:nth-child(15) { --bar-index: 15; height: 46%; }
.sonic-bars span:nth-child(16) { --bar-index: 16; height: 86%; }
.sonic-bars span:nth-child(17) { --bar-index: 17; height: 56%; }
.sonic-bars span:nth-child(18) { --bar-index: 18; height: 36%; }

.sonic-caption {
  position: absolute;
  right: 22px;
  bottom: 22px;
  left: 22px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: rgba(9, 10, 18, 0.5);
  padding: 14px 16px;
  backdrop-filter: blur(18px);
}

.sonic-caption span,
.sonic-caption strong {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.sonic-caption span {
  color: var(--ink-muted);
}

.sonic-caption strong {
  color: var(--accent);
}

.studio-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 18px;
}

.studio-stats div {
  border: 1px solid var(--border);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.055);
  padding: 15px 16px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(18px);
}

.studio-stats span,
.studio-stats strong {
  display: block;
}

.studio-stats span {
  margin-bottom: 6px;
  color: var(--ink-muted);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.studio-stats strong {
  color: var(--ink);
  font-family: 'Fraunces', Georgia, serif;
  font-size: 20px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  text-transform: capitalize;
  white-space: nowrap;
}

.editor {
  position: relative;
  background: var(--paper);
  border: 1px solid var(--border);
  border-radius: 28px;
  overflow: hidden;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.14) inset,
    0 34px 100px -54px rgba(0, 0, 0, 0.86),
    0 0 52px rgba(124, 247, 255, 0.08);
  backdrop-filter: blur(24px);
}

.editor::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  background: linear-gradient(90deg, var(--accent), var(--hot), #b8ff7c, var(--accent));
  background-size: 220% 100%;
  animation: shimmer-line 5s linear infinite;
}

.textarea-wrap {
  position: relative;
}

.mode-toggle {
  display: flex;
  gap: 8px;
  padding: 18px 20px 0;
}

.mode-toggle button {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--ink-muted);
  cursor: pointer;
  font-family: 'Manrope', sans-serif;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  padding: 8px 12px;
  text-transform: uppercase;
  transition:
    background 180ms ease,
    border-color 180ms ease,
    color 180ms ease;
}

.mode-toggle button:hover,
.mode-toggle button.active {
  background: linear-gradient(135deg, rgba(124, 247, 255, 0.22), rgba(255, 95, 203, 0.16));
  border-color: rgba(124, 247, 255, 0.52);
  color: var(--ink);
  box-shadow: 0 0 24px rgba(124, 247, 255, 0.14);
}

.url-fetcher {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px 14px;
  border-bottom: 1px dashed var(--border);
  background: linear-gradient(to bottom, rgba(255, 255, 255, 0.055), transparent);
}

.url-fetcher input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--ink);
  font-family: 'Fraunces', Georgia, serif;
  font-size: 17px;
  font-style: italic;
  outline: none;
}

.url-fetcher input::placeholder {
  color: var(--ink-muted);
  opacity: 0.58;
}

.url-fetcher button {
  border: 1px solid rgba(124, 247, 255, 0.42);
  border-radius: 999px;
  background: rgba(124, 247, 255, 0.08);
  color: var(--accent);
  cursor: pointer;
  font-family: 'Manrope', sans-serif;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  padding: 10px 14px;
  text-transform: uppercase;
  transition:
    background 180ms ease,
    border-color 180ms ease,
    color 180ms ease;
}

.url-fetcher button:hover:not(:disabled) {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
}

.url-fetcher button:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.feature-panel {
  display: grid;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px dashed var(--border);
  background: rgba(255, 255, 255, 0.025);
}

.preset-row,
.toolkit-row,
.mini-stats,
.tool-buttons {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.preset-row > span,
.draft-status {
  color: var(--ink-muted);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.preset-row > span {
  margin-right: 4px;
}

.preset-row button,
.tool-buttons button {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.045);
  color: var(--ink);
  cursor: pointer;
  font-family: 'Manrope', sans-serif;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.12em;
  padding: 8px 11px;
  text-transform: uppercase;
  transition:
    background 180ms ease,
    border-color 180ms ease,
    color 180ms ease,
    transform 120ms ease;
}

.preset-row button:hover:not(:disabled),
.tool-buttons button:hover:not(:disabled) {
  background: rgba(124, 247, 255, 0.16);
  border-color: rgba(124, 247, 255, 0.48);
  color: var(--accent);
  transform: translateY(-1px);
}

.preset-row button:disabled,
.tool-buttons button:disabled {
  cursor: not-allowed;
  opacity: 0.34;
}

.toolkit-row {
  justify-content: space-between;
}

.mini-stats {
  color: var(--ink-muted);
  font-size: 11px;
  font-weight: 700;
}

.mini-stats span {
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(9, 10, 18, 0.28);
}

.article-byline {
  padding: 18px 28px 0;
  color: var(--accent);
  font-family: 'Fraunces', Georgia, serif;
  font-size: 14px;
  font-style: italic;
}

.script-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 28px 0;
  color: var(--ink-muted);
  font-family: 'Manrope', sans-serif;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.improve-diff {
  margin: 18px 28px 0;
  border: 1px solid rgba(124, 247, 255, 0.28);
  border-radius: 18px;
  background: rgba(124, 247, 255, 0.055);
  overflow: hidden;
}

.improve-diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--ink-muted);
  font-family: 'Manrope', sans-serif;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.improve-diff-header button {
  border: none;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
}

.improve-diff-body {
  display: grid;
  gap: 10px;
  max-height: 240px;
  overflow: auto;
  padding: 12px;
  font-family: 'Fraunces', Georgia, serif;
  font-size: 15px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.improve-diff-body del {
  color: var(--ink-muted);
  opacity: 0.72;
  text-decoration-color: var(--hot);
  text-decoration-thickness: 2px;
}

.improve-diff-body mark {
  border-radius: 10px;
  background: rgba(184, 255, 124, 0.14);
  color: var(--ink);
  padding: 8px;
}

textarea {
  display: block;
  width: 100%;
  min-height: 240px;
  padding: 28px 28px 44px;
  border: none;
  background: transparent;
  font-family: 'Fraunces', Georgia, serif;
  font-size: 21px;
  line-height: 1.5;
  color: var(--ink);
  resize: vertical;
  outline: none;
  font-variation-settings: "SOFT" 30, "opsz" 20;
}

textarea::placeholder {
  color: var(--ink-muted);
  font-style: italic;
  opacity: 0.55;
}

.textarea-meta {
  position: absolute;
  right: 28px;
  bottom: 18px;
  display: flex;
  align-items: center;
  gap: 14px;
  pointer-events: none;
}

.char-counter,
.shortcut-hint,
.chunk-preview {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.shortcut-hint,
.chunk-preview {
  color: var(--ink-muted);
  opacity: 0.58;
}

.char-counter.muted {
  color: var(--ink-muted);
}

.char-counter.accent {
  color: var(--accent);
}

.char-counter.warning {
  color: var(--warning);
}

.voice-legend {
  padding: 16px 20px 18px;
  border-top: 1px dashed var(--border);
  background: rgba(255, 255, 255, 0.035);
}

.voice-legend-label {
  margin-bottom: 10px;
  color: var(--ink-muted);
  font-family: 'Manrope', sans-serif;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.voice-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.voice-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.055);
  color: var(--ink);
  font-family: 'Manrope', sans-serif;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.voice-chip select {
  max-width: 180px;
  border: none;
  background: transparent;
  color: var(--ink-muted);
  cursor: pointer;
  font-family: 'Fraunces', Georgia, serif;
  font-size: 13px;
  font-style: italic;
  outline: none;
}

.voice-chip:focus-within {
  border-color: var(--accent);
}

.controls {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 18px 20px;
  border-top: 1px dashed var(--border);
  background: linear-gradient(to bottom, rgba(255, 255, 255, 0.05), transparent);
}

.control-panel {
  flex: 1;
  min-width: 0;
}

.voice-control-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.voice-picker {
  position: relative;
  flex: 1;
  min-width: 0;
}

.voice-picker-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--ink);
  font-family: 'Manrope', sans-serif;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  padding: 10px 14px;
  letter-spacing: 0.01em;
  text-align: left;
}

.voice-picker-trigger:focus-visible {
  outline: 1px solid var(--accent);
}

.voice-picker-flag {
  flex: 0 0 auto;
}

.voice-picker-popover {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 8px);
  z-index: 8;
  max-height: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: var(--paper);
  box-shadow: 0 22px 48px -28px rgba(0, 0, 0, 0.74);
  opacity: 0;
  transform: translateY(-6px);
  transition:
    max-height 220ms ease,
    opacity 180ms ease,
    transform 180ms ease;
}

.voice-picker-popover.open {
  max-height: 360px;
  opacity: 1;
  transform: translateY(0);
}

.voice-picker-popover input {
  width: calc(100% - 20px);
  margin: 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--ink);
  font-family: 'Manrope', sans-serif;
  font-size: 12px;
  outline: none;
  padding: 9px 12px;
}

.voice-picker-list {
  max-height: 285px;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.voice-picker-option {
  display: grid;
  grid-template-columns: auto minmax(72px, auto) 1fr auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  padding: 10px;
  text-align: left;
}

.voice-picker-option:hover,
.voice-picker-option.active {
  background: rgba(124, 247, 255, 0.12);
}

.voice-picker-name {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 15px;
}

.voice-picker-detail {
  color: var(--ink-muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-picker-play {
  color: var(--accent);
  font-size: 11px;
}

.voice-picker-empty {
  padding: 12px;
  color: var(--ink-muted);
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic;
}

.improve-button {
  border: 1px solid rgba(124, 247, 255, 0.38);
  border-radius: 999px;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font-family: 'Manrope', sans-serif;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.12em;
  padding: 8px 11px;
  text-transform: uppercase;
  white-space: nowrap;
  transition:
    background 180ms ease,
    border-color 180ms ease,
    color 180ms ease,
    transform 120ms ease;
}

.improve-button:hover:not(:disabled) {
  background: rgba(124, 247, 255, 0.16);
  border-color: rgba(124, 247, 255, 0.58);
  transform: translateY(-1px);
}

.improve-button:disabled {
  cursor: not-allowed;
  opacity: 0.34;
}

.advanced-toggle,
.advanced-header button {
  border: none;
  background: transparent;
  color: var(--ink-muted);
  cursor: pointer;
  font-family: 'Fraunces', Georgia, serif;
  font-size: 13px;
  font-style: italic;
  padding: 0;
  transition: color 180ms ease;
}

.advanced-toggle:hover,
.advanced-header button:hover {
  color: var(--accent);
}

.advanced-panel {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px dashed var(--border);
}

.advanced-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
  color: var(--ink-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.slider-row {
  display: grid;
  grid-template-columns: 64px 1fr 52px;
  align-items: center;
  gap: 14px;
  padding: 8px 0;
  color: var(--ink);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.slider-row input[type="range"] {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  height: 18px;
  background: transparent;
  cursor: pointer;
}

.slider-row input[type="range"]::-webkit-slider-runnable-track {
  height: 1px;
  background: var(--border);
}

.slider-row input[type="range"]::-moz-range-track {
  height: 1px;
  background: var(--border);
}

.slider-row input[type="range"]::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  width: 13px;
  height: 13px;
  margin-top: -6px;
  border: 1px solid var(--accent-dark);
  border-radius: 999px;
  background: var(--accent);
}

.slider-row input[type="range"]::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border: 1px solid var(--accent-dark);
  border-radius: 999px;
  background: var(--accent);
}

.slider-row input[type="range"]:focus-visible {
  outline: none;
}

.slider-row input[type="range"]:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 4px rgba(180, 84, 58, 0.16);
}

.slider-row input[type="range"]:focus-visible::-moz-range-thumb {
  box-shadow: 0 0 0 4px rgba(180, 84, 58, 0.16);
}

.slider-value {
  color: var(--ink-muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

button.speak {
  font-family: 'Manrope', sans-serif;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #061017;
  background: linear-gradient(135deg, var(--accent), #b8ff7c);
  border: none;
  padding: 14px 24px;
  border-radius: 999px;
  cursor: pointer;
  transition:
    background 220ms ease,
    transform 120ms ease,
    letter-spacing 220ms ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  white-space: nowrap;
}

button.speak:not(.ghost) {
  min-width: 104px;
}

button.speak:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--hot), var(--accent));
  letter-spacing: 0.06em;
  box-shadow: 0 0 34px rgba(124, 247, 255, 0.28);
}

button.speak.ghost {
  color: var(--ink);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
  padding: 13px 18px;
}

button.speak.ghost:hover:not(:disabled) {
  color: var(--bg);
  background: var(--accent);
  border-color: var(--accent);
}

button.speak:active:not(:disabled) {
  transform: translateY(1px);
}

button.speak:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

button.speak .arrow {
  transition: transform 220ms ease;
}

button.speak:hover:not(:disabled) .arrow {
  transform: translateX(3px);
}

.history-sidebar {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 9;
  width: 320px;
  transform: translateX(-100%);
  transition: transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.history-sidebar.open {
  transform: translateX(0);
}

.history-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 26px 18px 18px;
  background: var(--paper);
  border-right: 1px solid var(--border);
  box-shadow: 24px 0 60px -36px rgba(0, 0, 0, 0.82);
  backdrop-filter: blur(24px);
}

.history-toggle {
  position: absolute;
  top: 24px;
  right: -44px;
  z-index: 1;
  width: 44px;
  height: 112px;
  border: 1px solid var(--border);
  border-left: none;
  border-radius: 0 16px 16px 0;
  background: var(--paper);
  color: var(--accent);
  cursor: pointer;
  font-family: 'Manrope', sans-serif;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  writing-mode: vertical-rl;
  text-orientation: mixed;
}

.history-header {
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}

.history-kicker {
  margin-bottom: 8px;
  color: var(--ink-muted);
  font-family: 'Manrope', sans-serif;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

.history-header h2 {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 32px;
  font-weight: 400;
  letter-spacing: -0.02em;
}

.history-list {
  flex: 1;
  min-height: 0;
  margin: 12px -8px;
  overflow-y: auto;
  padding: 0 8px;
}

.history-empty {
  padding: 18px 2px;
  color: var(--ink-muted);
  font-family: 'Fraunces', Georgia, serif;
  font-size: 16px;
  font-style: italic;
}

.history-entry {
  position: relative;
  display: block;
  width: 100%;
  margin-bottom: 8px;
  padding: 12px 32px 12px 12px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.045);
  color: var(--ink);
  cursor: pointer;
  text-align: left;
  transition:
    border-color 180ms ease,
    background 180ms ease;
}

.history-entry:hover,
.history-entry:focus-visible {
  border-color: rgba(124, 247, 255, 0.42);
  background: rgba(124, 247, 255, 0.075);
  outline: none;
}

.history-entry-text {
  display: block;
  margin-bottom: 8px;
  font-family: 'Fraunces', Georgia, serif;
  font-size: 15px;
  line-height: 1.35;
}

.history-entry-meta {
  display: block;
  color: var(--ink-muted);
  font-family: 'Manrope', sans-serif;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  line-height: 1.4;
  text-transform: uppercase;
}

.history-delete {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--ink-muted);
  cursor: pointer;
  font-family: 'Manrope', sans-serif;
  font-size: 16px;
  line-height: 1;
  opacity: 0;
  transition:
    color 180ms ease,
    opacity 180ms ease;
}

.history-entry:hover .history-delete,
.history-entry:focus-within .history-delete {
  opacity: 1;
}

.history-delete:hover {
  color: var(--accent);
}

.history-clear {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--ink);
  cursor: pointer;
  font-family: 'Manrope', sans-serif;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  padding: 12px 14px;
  text-transform: uppercase;
  transition:
    background 180ms ease,
    border-color 180ms ease,
    color 180ms ease;
}

.history-clear:hover:not(:disabled) {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
}

.history-clear:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.dots {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.dots span {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: currentColor;
  animation: dot-shimmer 1.2s ease-in-out infinite;
  opacity: 0.25;
}

.dots span:nth-child(2) {
  animation-delay: 200ms;
}

.dots span:nth-child(3) {
  animation-delay: 400ms;
}

.toast-stack {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(360px, calc(100vw - 32px));
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 16px 16px 16px 18px;
  background: var(--paper);
  border: 1px solid var(--border);
  border-left: 2px solid var(--ink);
  border-radius: 18px;
  box-shadow: 0 18px 42px -24px rgba(0, 0, 0, 0.82);
  backdrop-filter: blur(20px);
  animation: toast-slide-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

.toast.error {
  border-left-color: var(--accent);
}

.toast.success {
  border-left-color: var(--success);
}

.toast.info {
  border-left-color: var(--ink);
}

.toast-content {
  flex: 1;
}

.toast-type {
  margin-bottom: 6px;
  font-family: 'Manrope', sans-serif;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ink-muted);
}

.toast.error .toast-type {
  color: var(--accent);
}

.toast.success .toast-type {
  color: var(--success);
}

.toast.info .toast-type {
  color: var(--ink);
}

.toast-message {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 15px;
  line-height: 1.45;
  color: var(--ink);
}

.toast-close {
  border: none;
  background: transparent;
  color: var(--ink-muted);
  cursor: pointer;
  font-family: 'Manrope', sans-serif;
  font-size: 18px;
  line-height: 1;
  padding: 0;
  transition:
    color 180ms ease,
    transform 120ms ease;
}

.toast-close:hover {
  color: var(--accent);
}

.toast-close:active {
  transform: translateY(1px);
}

.player {
  margin-top: 32px;
  padding: 20px;
  background: var(--paper);
  border: 1px solid var(--border);
  border-radius: 26px;
  box-shadow:
    0 24px 80px -52px rgba(0, 0, 0, 0.86),
    inset 0 1px 0 rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(24px);
}

.player-row {
  display: flex;
  align-items: center;
  gap: 14px;
}

.player-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.player-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ink-muted);
}

.streaming-badge {
  position: relative;
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.streaming-badge::before {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 7px;
  border-radius: 999px;
  background: var(--accent);
  animation: stream-pulse 1.1s ease-in-out infinite;
}

audio {
  flex: 1;
  width: 100%;
  height: 40px;
}

.waveform-player {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.waveform-player audio {
  display: none;
}

.waveform-play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  border: 1px solid rgba(124, 247, 255, 0.42);
  border-radius: 999px;
  background: linear-gradient(135deg, var(--accent), var(--hot));
  color: var(--bg);
  cursor: pointer;
  transition:
    background 180ms ease,
    border-color 180ms ease,
    transform 120ms ease;
}

.waveform-play:hover {
  background: linear-gradient(135deg, var(--hot), #b8ff7c);
  border-color: var(--accent);
  box-shadow: 0 0 28px rgba(124, 247, 255, 0.24);
}

.waveform-play:active {
  transform: translateY(1px);
}

.waveform-main {
  flex: 1;
  min-width: 0;
}

.waveform-topline {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
}

.waveform-canvas {
  display: block;
  width: 100%;
  height: 58px;
}

.waveform-time {
  color: var(--ink-muted);
  font-family: ui-monospace, 'SF Mono', Monaco, 'Cascadia Mono', monospace;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.waveform-scrub {
  appearance: none;
  -webkit-appearance: none;
  display: block;
  width: 100%;
  height: 18px;
  margin-top: 6px;
  background: transparent;
  cursor: pointer;
}

.waveform-scrub::-webkit-slider-runnable-track {
  height: 1px;
  background: var(--border);
}

.waveform-scrub::-moz-range-track {
  height: 1px;
  background: var(--border);
}

.waveform-scrub::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  width: 11px;
  height: 11px;
  margin-top: -5px;
  border: 1px solid var(--accent-dark);
  border-radius: 999px;
  background: var(--accent);
}

.waveform-scrub::-moz-range-thumb {
  width: 11px;
  height: 11px;
  border: 1px solid var(--accent-dark);
  border-radius: 999px;
  background: var(--accent);
}

.waveform-scrub:focus-visible {
  outline: none;
}

.waveform-scrub:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 4px rgba(180, 84, 58, 0.16);
}

.waveform-scrub:focus-visible::-moz-range-thumb {
  box-shadow: 0 0 0 4px rgba(180, 84, 58, 0.16);
}

.footer-note {
  margin-top: 96px;
  padding-top: 28px;
  border-top: 1px solid var(--border);
  font-size: 13px;
  color: var(--ink-muted);
  line-height: 1.65;
}

.footer-note code {
  background: var(--paper);
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 12px;
  font-family: ui-monospace, 'SF Mono', Monaco, 'Cascadia Mono', monospace;
  color: var(--ink);
}

.share-page {
  max-width: 860px;
}

.share-card {
  padding: 34px;
  border: 1px solid var(--border);
  border-radius: 28px;
  background: var(--paper);
  box-shadow:
    0 34px 100px -54px rgba(0, 0, 0, 0.86),
    0 0 52px rgba(124, 247, 255, 0.08);
}

.share-text {
  margin: 24px 0 28px;
  color: var(--ink);
  font-family: 'Fraunces', Georgia, serif;
  font-size: clamp(28px, 5vw, 56px);
  line-height: 1.08;
  letter-spacing: -0.025em;
  white-space: pre-wrap;
}

.share-player {
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.045);
}

.share-footer {
  margin-top: 28px;
  color: var(--ink-muted);
  font-size: 13px;
  text-align: center;
}

.share-footer a {
  color: var(--accent);
  text-decoration: none;
}

/* Page-load stagger */
main > * {
  animation: rise 700ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
main > *:nth-child(1) { animation-delay: 0ms; }
main > *:nth-child(2) { animation-delay: 80ms; }
main > *:nth-child(3) { animation-delay: 160ms; }
main > *:nth-child(4) { animation-delay: 240ms; }
main > *:nth-child(5) { animation-delay: 320ms; }
main > *:nth-child(6) { animation-delay: 400ms; }

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes pulse-orb {
  0%,
  100% {
    opacity: 0.65;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.18);
  }
}

@keyframes sonic-ring {
  from {
    transform: rotate(0deg) scale(1);
  }
  50% {
    transform: rotate(180deg) scale(1.06);
  }
  to {
    transform: rotate(360deg) scale(1);
  }
}

@keyframes float-orb {
  0%,
  100% {
    transform: translate(-50%, -50%) translateY(0);
  }
  50% {
    transform: translate(-50%, -50%) translateY(-12px);
  }
}

@keyframes equalize {
  0%,
  100% {
    transform: scaleY(0.72);
  }
  50% {
    transform: scaleY(1.18);
  }
}

@keyframes dot-shimmer {
  0%,
  80%,
  100% {
    opacity: 0.25;
  }
  40% {
    opacity: 1;
  }
}

@keyframes toast-slide-in {
  from {
    opacity: 0;
    transform: translate(18px, 18px);
  }
  to {
    opacity: 1;
    transform: translate(0, 0);
  }
}

@keyframes stream-pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1.08);
  }
}

@keyframes shimmer-line {
  from {
    background-position: 0% 50%;
  }
  to {
    background-position: 220% 50%;
  }
}

@media (max-width: 860px) {
  .hero {
    grid-template-columns: 1fr;
  }

  .sonic-card {
    min-height: 280px;
  }

  .studio-stats {
    grid-template-columns: repeat(2, 1fr);
  }

  .toolkit-row {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 600px) {
  main {
    padding: 56px 20px 80px;
  }

  h1::after {
    right: 8px;
    top: -20px;
    width: 42px;
    height: 42px;
  }

  .hero {
    gap: 28px;
  }

  .sonic-card {
    min-height: 250px;
    border-radius: 24px;
  }

  .preview-kicker,
  .preview-voice {
    margin-left: 22px;
    margin-right: 22px;
  }

  .studio-stats {
    gap: 8px;
  }

  .studio-stats div {
    padding: 13px 14px;
  }

  .feature-panel {
    padding: 14px 16px;
  }

  .preset-row,
  .tool-buttons {
    align-items: stretch;
    flex-direction: column;
  }

  .preset-row > span {
    margin-right: 0;
  }

  .controls {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .voice-control-row {
    flex-direction: column;
    align-items: stretch;
  }

  .improve-button {
    width: 100%;
  }

  button.speak {
    width: 100%;
    justify-content: center;
  }

  .player-row {
    flex-direction: column;
    align-items: stretch;
  }

  .waveform-player {
    width: 100%;
  }

  .waveform-topline {
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .toast-stack {
    right: 16px;
    bottom: 16px;
  }

  .history-sidebar {
    width: min(320px, calc(100vw - 44px));
    transform: translateX(-100%);
  }

  .history-sidebar.open {
    transform: translateX(0);
  }
}

```

## app\api\extract\route.ts

```ts
import { NextRequest, NextResponse } from "next/server";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FETCH_TIMEOUT_MS = 2000;
const USER_AGENT =
  "TTS-Studio/1.0 (+https://localhost; URL-to-speech extraction)";

function parseUrl(value: unknown) {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

function htmlToPlainText(content: string) {
  const dom = new JSDOM(`<main>${content}</main>`);
  const paragraphs = Array.from(
    dom.window.document.querySelectorAll<HTMLParagraphElement>("p"),
  )
    .map((paragraph) => paragraph.textContent?.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return paragraphs.join("\n\n");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const url = parseUrl(body?.url);

    if (!url) {
      return NextResponse.json({ error: "Enter a valid URL." }, { status: 400 });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let html: string;

    try {
      // TODO: Respect robots.txt before fetching article pages.
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
      });

      if (!response.ok) {
        return NextResponse.json(
          { error: `Could not fetch that page (${response.status}).` },
          { status: response.status },
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) {
        return NextResponse.json(
          { error: "That URL did not return an HTML page." },
          { status: 400 },
        );
      }

      html = await response.text();
    } finally {
      clearTimeout(timeout);
    }

    const dom = new JSDOM(html, { url: url.toString() });
    const article = new Readability(dom.window.document).parse();

    if (!article?.textContent?.trim() && !article?.content?.trim()) {
      return NextResponse.json(
        { error: "Could not extract readable content from that page." },
        { status: 422 },
      );
    }

    const content = article.content
      ? htmlToPlainText(article.content)
      : (article.textContent ?? "").trim();

    if (!content) {
      return NextResponse.json(
        { error: "Could not extract readable content from that page." },
        { status: 422 },
      );
    }

    return NextResponse.json({
      title: article.title?.trim() ?? "",
      content,
      byline: article.byline?.trim() ?? "",
    });
  } catch (err) {
    const message =
      err instanceof DOMException && err.name === "AbortError"
        ? "Fetching that URL timed out."
        : err instanceof Error
          ? err.message
          : "Extraction failed.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

```

## app\api\improve\route.ts

```ts
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM_PROMPT =
  "You rewrite text to sound natural when spoken aloud. Expand contractions thoughtfully, break long sentences, add natural pauses with commas, remove parenthetical asides that confuse listeners, replace 'e.g.' with 'for example', spell out 'vs' as 'versus', etc. Return only the rewritten text â€” no commentary, no quotes around it.";

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY is not configured." },
        { status: 500 },
      );
    }

    const body = await req.json();
    const text = typeof body?.text === "string" ? body.text : "";

    if (!text.trim()) {
      return NextResponse.json(
        { error: "Please provide text to improve." },
        { status: 400 },
      );
    }

    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    });

    const improved = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!improved) {
      return NextResponse.json(
        { error: "No improved text was returned." },
        { status: 502 },
      );
    }

    return NextResponse.json({ text: improved });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not improve that text.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

```

## app\api\share\route.ts

```ts
import { NextRequest, NextResponse } from "next/server";
import { createShareId, saveShare } from "@/app/lib/shareStore";

const INLINE_WARNING_LENGTH = 8000;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const audioBase64 =
      typeof body?.audioBase64 === "string" ? body.audioBase64 : "";
    const text = typeof body?.text === "string" ? body.text : "";
    const voice = typeof body?.voice === "string" ? body.voice : "";

    if (!audioBase64 || !text.trim() || !voice.trim()) {
      return NextResponse.json(
        { error: "Audio, text, and voice are required." },
        { status: 400 },
      );
    }

    const id = createShareId();
    const { stored } = await saveShare({ id, audioBase64, text, voice });
    const origin = req.nextUrl.origin;

    if (stored) {
      return NextResponse.json({ id, url: `${origin}/share/${id}` });
    }

    const params = new URLSearchParams({
      audio: audioBase64,
      text,
      voice,
    });
    const url = `${origin}/share/inline?${params.toString()}`;
    const warning =
      url.length > INLINE_WARNING_LENGTH
        ? "Share link is large because Blob storage is not configured."
        : undefined;

    return NextResponse.json({ id: "inline", url, warning });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not create share link.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

```

## app\api\share\[id]\route.ts

```ts
import { NextRequest, NextResponse } from "next/server";
import {
  base64ToBuffer,
  getInlineShare,
  getStoredShare,
} from "@/app/lib/shareStore";

type RouteContext = {
  params: {
    id: string;
  };
};

export async function GET(req: NextRequest, { params }: RouteContext) {
  const inline =
    params.id === "inline"
      ? getInlineShare(Object.fromEntries(req.nextUrl.searchParams))
      : null;
  const share = inline ?? (await getStoredShare(params.id));

  if (!share) {
    return NextResponse.json({ error: "Share not found." }, { status: 404 });
  }

  if (share.audioUrl) {
    const response = await fetch(share.audioUrl, { cache: "force-cache" });
    if (!response.ok || !response.body) {
      return NextResponse.json({ error: "Audio not found." }, { status: 404 });
    }

    return new NextResponse(response.body, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  if (!share.audioBase64) {
    return NextResponse.json({ error: "Audio not found." }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(base64ToBuffer(share.audioBase64)), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

```

## app\api\tts\route.ts

```ts
import { NextRequest, NextResponse } from "next/server";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { parseDialogueScript } from "@/app/lib/dialogue";

// Run this route on the Node.js runtime (msedge-tts uses Node APIs,
// so this route will not run on the Edge runtime).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CHUNK_LENGTH = 4500;
const DEFAULT_DIALOGUE_VOICES: Record<string, string> = {
  Ava: "en-US-AvaNeural",
  Andrew: "en-US-AndrewNeural",
  Emma: "en-US-EmmaNeural",
  Brian: "en-US-BrianNeural",
  Jenny: "en-US-JennyNeural",
  Sonia: "en-GB-SoniaNeural",
  Ryan: "en-GB-RyanNeural",
  Natasha: "en-AU-NatashaNeural",
  Emily: "en-IE-EmilyNeural",
};

function toProsodyValue(value: unknown, min: number, max: number) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;

  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return char;
    }
  });
}

function buildSsml(
  text: string,
  voice: string,
  rate: number,
  pitch: number,
  volume: number,
) {
  return `<speak version="1.0" xml:lang="en-US">
    <voice name="${escapeXml(voice)}">
      <prosody rate="${rate}%" pitch="${pitch}st" volume="${volume}%">
        ${escapeXml(text)}
      </prosody>
    </voice>
  </speak>`;
}

function buildDialogueSsml(
  text: string,
  voice: string,
  rate: number,
  pitch: number,
  volume: number,
  pauseAfterMs: number,
) {
  const breakTag = `<break time="${pauseAfterMs}ms"/>`;
  const content = `${escapeXml(text)} ${breakTag}`;
  const hasProsody = rate !== 0 || pitch !== 0 || volume !== 0;

  return `<speak version="1.0" xml:lang="en-US">
    <voice name="${escapeXml(voice)}">
      ${
        hasProsody
          ? `<prosody rate="${rate}%" pitch="${pitch}st" volume="${volume}%">${content}</prosody>`
          : content
      }
    </voice>
  </speak>`;
}

function buildPauseSsml(voice: string, pauseMs: number) {
  return `<speak version="1.0" xml:lang="en-US">
    <voice name="${escapeXml(voice)}">
      <break time="${pauseMs}ms"/>
    </voice>
  </speak>`;
}

function splitIntoSentences(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const matches = normalized.match(/.*?(?:[.!?](?=\s|$)|$)/g) ?? [];

  return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

function splitIntoChunks(text: string) {
  const sentences = splitIntoSentences(text);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;

    if (next.length <= MAX_CHUNK_LENGTH) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    current = sentence;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function pipeAudioStream(
  input: string,
  voice: string,
  rate: number,
  pitch: number,
  volume: number,
  isSsml: boolean,
  onChunk: (chunk: Uint8Array) => void,
) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(
    voice,
    OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
  );

  const hasProsody = rate !== 0 || pitch !== 0 || volume !== 0;
  const ttsInput = isSsml
    ? input
    : hasProsody
      ? buildSsml(input, voice, rate, pitch, volume)
      : input;
  const audioStream = tts.toStream(ttsInput);

  // Event-based stream handling works across msedge-tts versions more reliably
  // than `for await`, and lets us forward bytes immediately to the response.
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      resolve();
    }

    audioStream.on("data", (chunk: Buffer) => {
      onChunk(new Uint8Array(Buffer.from(chunk)));
    });
    audioStream.on("end", finish);
    audioStream.on("close", finish);
    audioStream.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function getSpeakerVoice(
  speaker: string,
  speakerVoices: Record<string, unknown>,
  fallbackVoice: string,
) {
  const mappedVoice = speakerVoices[speaker];
  if (typeof mappedVoice === "string" && mappedVoice.trim()) {
    return mappedVoice;
  }

  return DEFAULT_DIALOGUE_VOICES[speaker] ?? fallbackVoice;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const mode: "monologue" | "dialogue" =
      body?.mode === "dialogue" ? "dialogue" : "monologue";
    const text: string = body?.text ?? "";
    const script: string = body?.script ?? "";
    const voice: string = body?.voice ?? "en-US-AvaNeural";
    const rate = toProsodyValue(body?.rate, -50, 50);
    const pitch = toProsodyValue(body?.pitch, -10, 10);
    const volume = toProsodyValue(body?.volume, -50, 50);
    const speakerVoices =
      body?.speakerVoices && typeof body.speakerVoices === "object"
        ? (body.speakerVoices as Record<string, unknown>)
        : {};

    if (mode === "monologue" && (!text || typeof text !== "string" || !text.trim())) {
      return NextResponse.json(
        { error: "Please provide some text." },
        { status: 400 },
      );
    }

    if (
      mode === "dialogue" &&
      (!script || typeof script !== "string" || !script.trim())
    ) {
      return NextResponse.json(
        { error: "Please provide a dialogue script." },
        { status: 400 },
      );
    }

    const dialogueSegments =
      mode === "dialogue" ? parseDialogueScript(script) : [];
    const chunks = mode === "monologue" ? splitIntoChunks(text) : [];

    const stream = new ReadableStream({
      async start(controller) {
        let failed = false;

        try {
          if (mode === "dialogue") {
            for (let index = 0; index < dialogueSegments.length; index += 1) {
              const segment = dialogueSegments[index];
              const segmentVoice = getSpeakerVoice(
                segment.speaker,
                speakerVoices,
                voice,
              );

              const ssml =
                segment.type === "pause"
                  ? buildPauseSsml(segmentVoice, segment.pauseMs)
                  : buildDialogueSsml(
                      segment.text,
                      segmentVoice,
                      rate,
                      pitch,
                      volume,
                      segment.pauseAfterMs,
                    );

              await pipeAudioStream(
                ssml,
                segmentVoice,
                rate,
                pitch,
                volume,
                true,
                (chunk) => controller.enqueue(chunk),
              );
            }
          } else {
            for (let index = 0; index < chunks.length; index += 1) {
              await pipeAudioStream(
                chunks[index],
                voice,
                rate,
                pitch,
                volume,
                false,
                (chunk) => controller.enqueue(chunk),
              );
            }
          }
        } catch (err) {
          console.error("TTS error:", err);
          failed = true;
          controller.error(err);
          return;
        } finally {
          if (!failed) {
            controller.close();
          }
        }
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "TTS generation failed.";
    console.error("TTS error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

```

## app\components\History.tsx

```tsx
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
                  Ã—
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

```

## app\components\Toast.tsx

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ToastType = "error" | "success" | "info";

export type ToastMessage = {
  id: string;
  type: ToastType;
  message: string;
};

type ToastInput = {
  type?: ToastType;
  message: string;
};

type ToastProps = {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
};

const TOAST_TIMEOUT_MS = 5000;

export function useToast() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const nextId = useRef(0);

  const dismissToast = useCallback((id: string) => {
    const timeout = timeouts.current[id];
    if (timeout) {
      clearTimeout(timeout);
      delete timeouts.current[id];
    }

    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    ({ message, type = "info" }: ToastInput) => {
      const id = `toast-${Date.now()}-${nextId.current}`;
      nextId.current += 1;

      setToasts((current) => [...current, { id, type, message }]);
      timeouts.current[id] = setTimeout(() => {
        dismissToast(id);
      }, TOAST_TIMEOUT_MS);

      return id;
    },
    [dismissToast],
  );

  useEffect(() => {
    return () => {
      Object.values(timeouts.current).forEach(clearTimeout);
    };
  }, []);

  return { toasts, showToast, dismissToast };
}

export function Toast({ toasts, onDismiss }: ToastProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div className={`toast ${toast.type}`} key={toast.id} role="status">
          <div className="toast-content">
            <div className="toast-type">{toast.type}</div>
            <div className="toast-message">{toast.message}</div>
          </div>
          <button
            className="toast-close"
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
          >
            Ã—
          </button>
        </div>
      ))}
    </div>
  );
}

```

## app\components\VoicePicker.tsx

```tsx
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
  const audioRef = useRef<HTMLAudioElement | null>(null);
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
      audioRef.current?.pause();
    }
  }, [open]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  function playSample(voice: Voice) {
    audioRef.current?.pause();
    const audio = new Audio(`/samples/${voice.id}.mp3`);
    audioRef.current = audio;
    void audio.play().catch(() => {
      /* Sample files are generated separately and may not exist in development. */
    });
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
        <span className="voice-picker-flag">{getVoiceFlag(selectedVoice.id)}</span>
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
            <button
              className={`voice-picker-option ${
                index === activeIndex ? "active" : ""
              }`}
              type="button"
              key={voice.id}
              onClick={() => selectVoice(voice)}
              onMouseEnter={() => {
                setActiveIndex(index);
                playSample(voice);
              }}
              onTouchStart={() => {
                setActiveIndex(index);
                playSample(voice);
              }}
              role="option"
              aria-selected={voice.id === value}
            >
              <span className="voice-picker-flag">{getVoiceFlag(voice.id)}</span>
              <span className="voice-picker-name">{getVoiceName(voice.label)}</span>
              <span className="voice-picker-detail">{voice.label}</span>
              <span className="voice-picker-play" aria-hidden>
                â–¶
              </span>
            </button>
          ))}
          {filteredVoices.length === 0 && (
            <div className="voice-picker-empty">No voices found.</div>
          )}
        </div>
      </div>
    </div>
  );
}

```

## app\components\Waveform.tsx

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type WaveformProps = {
  src: string;
  autoPlay?: boolean;
};

const BAR_COUNT = 60;
const DECAY = 0.88;

function formatTime(value: number) {
  if (!Number.isFinite(value)) return "0:00";

  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function getCanvasColor(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;

  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

export function Waveform({ src, autoPlay = false }: WaveformProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const levelsRef = useRef<number[]>(Array(BAR_COUNT).fill(0.08));
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const draw = useCallback((active = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const rect = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);

    if (canvas.width !== Math.floor(width * pixelRatio)) {
      canvas.width = Math.floor(width * pixelRatio);
    }

    if (canvas.height !== Math.floor(height * pixelRatio)) {
      canvas.height = Math.floor(height * pixelRatio);
    }

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    const accent = getCanvasColor("--accent", "#b4543a");
    const muted = getCanvasColor("--border", "#d4c9b2");
    const gap = 3;
    const barWidth = Math.max(2, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT);
    const center = height / 2;
    const data = new Uint8Array(analyserRef.current?.frequencyBinCount || 0);

    if (active && analyserRef.current) {
      analyserRef.current.getByteFrequencyData(data);
    }

    for (let index = 0; index < BAR_COUNT; index += 1) {
      const bucketStart = Math.floor((index / BAR_COUNT) * data.length);
      const bucketEnd = Math.max(
        bucketStart + 1,
        Math.floor(((index + 1) / BAR_COUNT) * data.length),
      );
      let total = 0;

      for (let bucket = bucketStart; bucket < bucketEnd; bucket += 1) {
        total += data[bucket] || 0;
      }

      const target = active ? total / (bucketEnd - bucketStart) / 255 : 0.08;
      levelsRef.current[index] = active
        ? Math.max(target, levelsRef.current[index] * DECAY)
        : levelsRef.current[index];

      const level = active ? levelsRef.current[index] : levelsRef.current[index];
      const barHeight = Math.max(4, level * (height - 8));
      const x = index * (barWidth + gap);
      const y = center - barHeight / 2;

      context.fillStyle = active ? accent : muted;
      context.globalAlpha = active ? 0.9 : 0.55;
      context.fillRect(x, y, barWidth, barHeight);
    }

    context.globalAlpha = 1;
  }, []);

  const stopAnimation = useCallback(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const animate = useCallback(() => {
    draw(true);
    animationRef.current = requestAnimationFrame(animate);
  }, [draw]);

  const ensureAudioGraph = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return null;

    if (!audioContextRef.current) {
      const AudioContextConstructor =
        window.AudioContext ||
        (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext;

      if (!AudioContextConstructor) return null;

      const audioContext = new AudioContextConstructor();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;

      const source = audioContext.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(audioContext.destination);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      sourceRef.current = source;
    }

    return audioContextRef.current;
  }, []);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    const audioContext = ensureAudioGraph();
    if (!audio || !audioContext) return;

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    await audio.play();
  }, [ensureAudioGraph]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      void play();
    } else {
      audio.pause();
    }
  }, [play]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver(() => draw(playing));
    observer.observe(canvas);
    draw(false);

    return () => observer.disconnect();
  }, [draw, playing]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.load();
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    levelsRef.current = Array(BAR_COUNT).fill(0.08);
    stopAnimation();
    draw(false);

    if (autoPlay) {
      void play();
    }
  }, [autoPlay, draw, play, src, stopAnimation]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleLoadedMetadata = () => {
      setDuration(audio.duration || 0);
      setCurrentTime(audio.currentTime || 0);
    };
    const handleTimeUpdate = () => setCurrentTime(audio.currentTime || 0);
    const handlePlay = () => {
      setPlaying(true);
      stopAnimation();
      animate();
    };
    const handlePause = () => {
      setPlaying(false);
      stopAnimation();
      draw(false);
    };
    const handleEnded = () => {
      setPlaying(false);
      setCurrentTime(0);
      levelsRef.current = Array(BAR_COUNT).fill(0.08);
      stopAnimation();
      draw(false);
    };

    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [animate, draw, stopAnimation]);

  useEffect(() => {
    return () => {
      stopAnimation();
      sourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      void audioContextRef.current?.close();
    };
  }, [stopAnimation]);

  return (
    <div className="waveform-player">
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        className="waveform-play"
        type="button"
        onClick={togglePlayback}
        aria-label={playing ? "Pause audio" : "Play audio"}
      >
        {playing ? (
          <svg
            aria-hidden
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M7 5h4v14H7z" />
            <path d="M13 5h4v14h-4z" />
          </svg>
        ) : (
          <svg
            aria-hidden
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <div className="waveform-main">
        <div className="waveform-topline">
          <canvas className="waveform-canvas" ref={canvasRef} />
          <div className="waveform-time">
            {formatTime(currentTime)} / {formatTime(duration)}
          </div>
        </div>
        <input
          className="waveform-scrub"
          type="range"
          min="0"
          max={duration || 0}
          step="0.01"
          value={Math.min(currentTime, duration || 0)}
          onChange={(event) => {
            const nextTime = Number(event.target.value);
            if (audioRef.current) {
              audioRef.current.currentTime = nextTime;
            }
            setCurrentTime(nextTime);
          }}
          aria-label="Scrub audio"
        />
      </div>
    </div>
  );
}

```

## app\lib\dialogue.ts

```ts
export type DialogueSegment =
  | {
      type: "speech";
      speaker: string;
      text: string;
      pauseAfterMs: number;
    }
  | {
      type: "pause";
      speaker: string;
      pauseMs: number;
    };

const DEFAULT_SPEAKER = "Ava";
const LINE_PAUSE_MS = 400;
const BLANK_LINE_PAUSE_MS = 800;
const WORDS_PER_MINUTE = 155;

function parseLine(line: string) {
  const match = line.match(/^([^:]{1,80}):\s*(.*)$/);
  if (!match) return null;

  const [, rawSpeaker, rawText] = match;
  const speaker = rawSpeaker.trim();
  const text = rawText.trim();

  if (!speaker || !text) return null;

  return { speaker, text };
}

export function parseDialogueScript(script: string) {
  const segments: DialogueSegment[] = [];
  let lastSpeaker = DEFAULT_SPEAKER;

  for (const line of script.replace(/\s+$/, "").split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) {
      segments.push({
        type: "pause",
        speaker: lastSpeaker,
        pauseMs: BLANK_LINE_PAUSE_MS,
      });
      continue;
    }

    const parsed = parseLine(trimmed);

    if (parsed) {
      lastSpeaker = parsed.speaker;
      segments.push({
        type: "speech",
        speaker: parsed.speaker,
        text: parsed.text,
        pauseAfterMs: LINE_PAUSE_MS,
      });
      continue;
    }

    segments.push({
      type: "speech",
      speaker: lastSpeaker,
      text: trimmed,
      pauseAfterMs: LINE_PAUSE_MS,
    });
  }

  return segments;
}

export function getDialogueSpeakers(script: string) {
  const speakers = new Set<string>();

  for (const segment of parseDialogueScript(script)) {
    speakers.add(segment.speaker);
  }

  return Array.from(speakers);
}

export function getDialogueLineCount(script: string) {
  return parseDialogueScript(script).filter((segment) => segment.type === "speech")
    .length;
}

export function estimateDialogueDurationSeconds(script: string) {
  return Math.ceil(
    parseDialogueScript(script).reduce((total, segment) => {
      if (segment.type === "pause") {
        return total + segment.pauseMs / 1000;
      }

      const words = segment.text.split(/\s+/).filter(Boolean).length;
      return total + (words / WORDS_PER_MINUTE) * 60 + segment.pauseAfterMs / 1000;
    }, 0),
  );
}

/*
Unit-style examples:

parseDialogueScript("Ava: Hello.\nBrian: Hi.")
=> [
  { type: "speech", speaker: "Ava", text: "Hello.", pauseAfterMs: 400 },
  { type: "speech", speaker: "Brian", text: "Hi.", pauseAfterMs: 400 },
]

parseDialogueScript("Dr. Chen: Begin.\nContinue without label.")
=> [
  { type: "speech", speaker: "Dr. Chen", text: "Begin.", pauseAfterMs: 400 },
  { type: "speech", speaker: "Dr. Chen", text: "Continue without label.", pauseAfterMs: 400 },
]

parseDialogueScript("Ava: First.\n\nSecond.")
=> [
  { type: "speech", speaker: "Ava", text: "First.", pauseAfterMs: 400 },
  { type: "pause", speaker: "Ava", pauseMs: 800 },
  { type: "speech", speaker: "Ava", text: "Second.", pauseAfterMs: 400 },
]
*/

```

## app\lib\shareStore.ts

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { head, put } from "@vercel/blob";

export type ShareRecord = {
  id: string;
  text: string;
  voice: string;
  audioBase64?: string;
  audioUrl?: string;
  createdAt: string;
};

const LOCAL_SHARE_DIR = join("/tmp", "tts-studio-shares");

function useLocalStore() {
  return process.env.NODE_ENV !== "production";
}

function useBlobStore() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export function createShareId() {
  return crypto.randomUUID();
}

export function stripDataUrl(value: string) {
  const commaIndex = value.indexOf(",");
  return value.startsWith("data:") && commaIndex !== -1
    ? value.slice(commaIndex + 1)
    : value;
}

export function base64ToBuffer(value: string) {
  return Buffer.from(stripDataUrl(value), "base64");
}

function metadataPath(id: string) {
  return join(LOCAL_SHARE_DIR, `${id}.json`);
}

function audioPath(id: string) {
  return join(LOCAL_SHARE_DIR, `${id}.mp3`);
}

export async function saveShare(input: {
  id: string;
  audioBase64: string;
  text: string;
  voice: string;
}) {
  const createdAt = new Date().toISOString();
  const audioBuffer = base64ToBuffer(input.audioBase64);

  if (useLocalStore()) {
    await mkdir(LOCAL_SHARE_DIR, { recursive: true });
    await writeFile(audioPath(input.id), audioBuffer);
    await writeFile(
      metadataPath(input.id),
      JSON.stringify({
        id: input.id,
        text: input.text,
        voice: input.voice,
        createdAt,
      }),
    );

    return { stored: true, record: { ...input, createdAt } };
  }

  if (useBlobStore()) {
    const [audioBlob, metadataBlob] = await Promise.all([
      put(`tts-shares/${input.id}.mp3`, audioBuffer, {
        access: "public",
        contentType: "audio/mpeg",
      }),
      put(
        `tts-shares/${input.id}.json`,
        JSON.stringify({
          id: input.id,
          text: input.text,
          voice: input.voice,
          createdAt,
        }),
        {
          access: "public",
          contentType: "application/json",
        },
      ),
    ]);

    return {
      stored: true,
      record: {
        id: input.id,
        text: input.text,
        voice: input.voice,
        audioUrl: audioBlob.url,
        createdAt,
        metadataUrl: metadataBlob.url,
      },
    };
  }

  return {
    stored: false,
    record: {
      id: input.id,
      text: input.text,
      voice: input.voice,
      audioBase64: input.audioBase64,
      createdAt,
    },
  };
}

export async function getStoredShare(id: string): Promise<ShareRecord | null> {
  if (useLocalStore()) {
    try {
      const [metadata, audio] = await Promise.all([
        readFile(metadataPath(id), "utf8"),
        readFile(audioPath(id)),
      ]);
      const parsed = JSON.parse(metadata) as ShareRecord;

      return {
        ...parsed,
        audioBase64: `data:audio/mpeg;base64,${audio.toString("base64")}`,
      };
    } catch {
      return null;
    }
  }

  if (useBlobStore()) {
    try {
      const [metadataHead, audioHead] = await Promise.all([
        head(`tts-shares/${id}.json`),
        head(`tts-shares/${id}.mp3`),
      ]);
      const response = await fetch(metadataHead.url, { cache: "force-cache" });
      if (!response.ok) return null;
      const metadata = (await response.json()) as ShareRecord;

      return {
        ...metadata,
        audioUrl: audioHead.url,
      };
    } catch {
      return null;
    }
  }

  return null;
}

export function getInlineShare(searchParams: {
  audio?: string | string[];
  text?: string | string[];
  voice?: string | string[];
}): ShareRecord | null {
  const audio = Array.isArray(searchParams.audio)
    ? searchParams.audio[0]
    : searchParams.audio;
  const text = Array.isArray(searchParams.text)
    ? searchParams.text[0]
    : searchParams.text;
  const voice = Array.isArray(searchParams.voice)
    ? searchParams.voice[0]
    : searchParams.voice;

  if (!audio || !text || !voice) return null;

  return {
    id: "inline",
    text,
    voice,
    audioBase64: audio,
    createdAt: new Date().toISOString(),
  };
}

```

## app\lib\voices.ts

```ts
export type Voice = {
  id: string;
  label: string;
};

export const VOICES: Voice[] = [
  { id: "en-US-AvaNeural", label: "Ava â€” US English, conversational" },
  { id: "en-US-AndrewNeural", label: "Andrew â€” US English, warm" },
  { id: "en-US-EmmaNeural", label: "Emma â€” US English, expressive" },
  { id: "en-US-BrianNeural", label: "Brian â€” US English, casual" },
  { id: "en-US-JennyNeural", label: "Jenny â€” US English, friendly" },
  { id: "en-GB-SoniaNeural", label: "Sonia â€” UK English" },
  { id: "en-GB-RyanNeural", label: "Ryan â€” UK English" },
  { id: "en-AU-NatashaNeural", label: "Natasha â€” Australian English" },
  { id: "en-IE-EmilyNeural", label: "Emily â€” Irish English" },
];

export const DEFAULT_SPEAKER_VOICES: Record<string, string> = {
  Ava: "en-US-AvaNeural",
  Andrew: "en-US-AndrewNeural",
  Emma: "en-US-EmmaNeural",
  Brian: "en-US-BrianNeural",
  Jenny: "en-US-JennyNeural",
  Sonia: "en-GB-SoniaNeural",
  Ryan: "en-GB-RyanNeural",
  Natasha: "en-AU-NatashaNeural",
  Emily: "en-IE-EmilyNeural",
};

export function getVoiceName(label: string) {
  return label.split(" â€” ")[0];
}

export function getVoiceLocale(voiceId: string) {
  return voiceId.match(/^[a-z]{2}-[A-Z]{2}/)?.[0] ?? "en-US";
}

export function getVoiceFlag(voiceId: string) {
  const region = getVoiceLocale(voiceId).split("-")[1] ?? "US";
  const codePoints = [...region.toUpperCase()].map(
    (letter) => 127397 + letter.charCodeAt(0),
  );

  return String.fromCodePoint(...codePoints);
}

```

## app\share\[id]\page.tsx

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Waveform } from "@/app/components/Waveform";
import { getInlineShare, getStoredShare } from "@/app/lib/shareStore";

type SharePageProps = {
  params: {
    id: string;
  };
  searchParams: {
    audio?: string;
    text?: string;
    voice?: string;
  };
};

async function loadShare({ params, searchParams }: SharePageProps) {
  if (params.id === "inline") {
    return getInlineShare(searchParams);
  }

  return getStoredShare(params.id);
}

export async function generateMetadata(
  props: SharePageProps,
): Promise<Metadata> {
  const share = await loadShare(props);
  const title = share
    ? `${share.text.slice(0, 80)}${share.text.length > 80 ? "..." : ""}`
    : "Shared TTS audio";

  return {
    title,
    description: "A generated audio clip from Free TTS Studio.",
    openGraph: {
      title,
      description: "Listen to this generated audio clip.",
      type: "music.song",
    },
    twitter: {
      card: "summary",
      title,
      description: "Listen to this generated audio clip.",
    },
  };
}

export default async function SharePage(props: SharePageProps) {
  const share = await loadShare(props);

  if (!share) {
    notFound();
  }

  const audioSrc =
    share.audioBase64 ??
    `/api/share/${share.id}`;

  return (
    <main className="share-page">
      <section className="share-card">
        <div className="eyebrow">Shared Audio</div>
        <p className="share-text">{share.text}</p>
        <div className="share-player">
          <Waveform src={audioSrc} />
        </div>
      </section>
      <footer className="share-footer">
        Created with <Link href="/">Free TTS Studio</Link>
      </footer>
    </main>
  );
}

```

## scripts\generate-samples.ts

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { VOICES, getVoiceName } from "../app/lib/voices";

async function streamToBuffer(audioStream: NodeJS.ReadableStream) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];

    audioStream.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
    });
    audioStream.on("end", () => resolve(Buffer.concat(chunks)));
    audioStream.on("close", () => resolve(Buffer.concat(chunks)));
    audioStream.on("error", reject);
  });
}

async function generateSample(voiceId: string, voiceName: string) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(
    voiceId,
    OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
  );

  const text = `Hello, I'm ${voiceName}. How would you like me to read your text?`;
  const audioStream = tts.toStream(text);

  return streamToBuffer(audioStream);
}

async function main() {
  const outputDir = join(process.cwd(), "public", "samples");
  await mkdir(outputDir, { recursive: true });

  for (const voice of VOICES) {
    const voiceName = getVoiceName(voice.label);
    try {
      const buffer = await generateSample(voice.id, voiceName);
      const outputPath = join(outputDir, `${voice.id}.mp3`);
      await writeFile(outputPath, buffer);
      console.log(`Generated ${outputPath}`);
    } catch (error) {
      console.error(`Failed to generate ${voice.id}:`, error);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

```


