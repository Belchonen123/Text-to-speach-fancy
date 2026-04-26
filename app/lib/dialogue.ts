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
