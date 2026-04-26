import { getBrowserVoiceURI, getVoiceLocale } from "./voices";

export type BrowserProsody = {
  rate: number;
  pitch: number;
  volume: number;
};

const MAX_BROWSER_UTTERANCE_LENGTH = 240;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function splitIntoSentences(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  const matches = normalized.match(/.*?(?:[.!?](?=\s|$)|$)/g) ?? [];

  return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

function splitLongSentence(sentence: string) {
  const chunks: string[] = [];
  let current = "";

  for (const word of sentence.split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;

    if (next.length <= MAX_BROWSER_UTTERANCE_LENGTH) {
      current = next;
      continue;
    }

    if (current) chunks.push(current);
    current = word;
  }

  if (current) chunks.push(current);
  return chunks;
}

function splitIntoBrowserUtteranceText(value: string) {
  const chunks: string[] = [];
  let current = "";

  for (const sentence of splitIntoSentences(value)) {
    if (sentence.length > MAX_BROWSER_UTTERANCE_LENGTH) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitLongSentence(sentence));
      continue;
    }

    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length <= MAX_BROWSER_UTTERANCE_LENGTH) {
      current = next;
      continue;
    }

    if (current) chunks.push(current);
    current = sentence;
  }

  if (current) chunks.push(current);
  return chunks;
}

function getBrowserVoiceForVoiceId(voiceId: string) {
  const voices = window.speechSynthesis.getVoices();
  const browserVoiceURI = getBrowserVoiceURI(voiceId);

  if (browserVoiceURI) {
    const voice =
      voices.find((item) => item.voiceURI === browserVoiceURI) ??
      voices.find((item) => item.name === browserVoiceURI) ??
      null;

    return {
      locale: voice?.lang ?? "en-US",
      voice,
    };
  }

  const locale = getVoiceLocale(voiceId);

  return {
    locale,
    voice:
      voices.find((item) => item.lang.toLowerCase() === locale.toLowerCase()) ??
      voices.find((item) =>
        item.lang.toLowerCase().startsWith(locale.slice(0, 2).toLowerCase()),
      ) ??
      null,
  };
}

export function configureBrowserUtterance(
  utterance: SpeechSynthesisUtterance,
  voiceId: string,
  prosody: BrowserProsody,
) {
  const browserVoice = getBrowserVoiceForVoiceId(voiceId);

  utterance.lang = browserVoice.voice?.lang ?? browserVoice.locale;
  utterance.voice = browserVoice.voice;
  utterance.rate = clamp(1 + prosody.rate / 100, 0.1, 2);
  utterance.pitch = clamp(1 + prosody.pitch / 10, 0, 2);
  utterance.volume = clamp(1 + prosody.volume / 100, 0, 1);
}

export function cancelBrowserSpeech() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

export function speakTextWithBrowser(
  text: string,
  voiceId: string,
  prosody: BrowserProsody,
) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return Promise.resolve(false);
  }

  const trimmedText = text.trim();
  if (!trimmedText) return Promise.resolve(false);

  const chunks = splitIntoBrowserUtteranceText(trimmedText);
  if (chunks.length === 0) return Promise.resolve(false);

  const speakChunk = (chunk: string) =>
    new Promise<boolean>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      configureBrowserUtterance(utterance, voiceId, prosody);

      let settled = false;
      const settle = (result: boolean) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      utterance.onend = () => settle(true);
      utterance.onerror = () => settle(false);

      window.speechSynthesis.speak(utterance);
      window.speechSynthesis.resume();
    });

  return (async () => {
    window.speechSynthesis.cancel();

    for (const chunk of chunks) {
      const spoke = await speakChunk(chunk);
      if (!spoke) return false;
    }

    return true;
  })();
}
