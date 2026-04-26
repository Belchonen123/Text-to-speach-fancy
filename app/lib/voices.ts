export type Voice = {
  id: string;
  label: string;
  locale?: string;
};

const BROWSER_VOICE_PREFIX = "browser:";

export const VOICES: Voice[] = [
  { id: "en-US-AvaNeural", label: "Ava — US English, conversational" },
  { id: "en-US-AndrewNeural", label: "Andrew — US English, warm" },
  { id: "en-US-EmmaNeural", label: "Emma — US English, expressive" },
  { id: "en-US-BrianNeural", label: "Brian — US English, casual" },
  { id: "en-US-JennyNeural", label: "Jenny — US English, friendly" },
  { id: "en-GB-SoniaNeural", label: "Sonia — UK English" },
  { id: "en-GB-RyanNeural", label: "Ryan — UK English" },
  { id: "en-AU-NatashaNeural", label: "Natasha — Australian English" },
  { id: "en-IE-EmilyNeural", label: "Emily — Irish English" },
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
  return label.split(" — ")[0];
}

export function getVoiceLocale(voiceId: string) {
  return voiceId.match(/^[a-z]{2}-[A-Z]{2}/)?.[0] ?? "en-US";
}

export function getBrowserVoiceId(voice: SpeechSynthesisVoice) {
  return `${BROWSER_VOICE_PREFIX}${encodeURIComponent(voice.voiceURI)}`;
}

export function getBrowserVoiceURI(voiceId: string) {
  if (!voiceId.startsWith(BROWSER_VOICE_PREFIX)) return null;

  try {
    return decodeURIComponent(voiceId.slice(BROWSER_VOICE_PREFIX.length));
  } catch {
    return null;
  }
}

export function getVoiceFlag(voiceId: string) {
  const region = getVoiceLocale(voiceId).split("-")[1] ?? "US";
  const codePoints = [...region.toUpperCase()].map(
    (letter) => 127397 + letter.charCodeAt(0),
  );

  return String.fromCodePoint(...codePoints);
}

/** Map UI voice (browser URI id or Edge neural id) to an Edge neural voice for /api/tts. */
export function resolveEdgeVoiceId(
  voiceId: string,
  localeHint?: string | null,
): string {
  if (VOICES.some((v) => v.id === voiceId)) {
    return voiceId;
  }

  const normalized = (localeHint ?? "")
    .replace(/_/g, "-")
    .trim()
    .toLowerCase();

  if (normalized) {
    const prefix = normalized.split("-").slice(0, 2).join("-");
    const exact = VOICES.find(
      (v) =>
        v.id.split("-").slice(0, 2).join("-").toLowerCase() === prefix,
    );
    if (exact) return exact.id;

    const langOnly = normalized.split("-")[0];
    const langMatch = VOICES.find((v) =>
      v.id.toLowerCase().startsWith(`${langOnly}-`),
    );
    if (langMatch) return langMatch.id;
  }

  return VOICES[0].id;
}
