import { NextRequest, NextResponse } from "next/server";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { parseDialogueScript } from "@/app/lib/dialogue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Vercel: raise default (10s) so MP3 generation can finish (Hobby max 60s; Pro allows more). */
export const maxDuration = 60;

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

function ttsFailureMessage(err: unknown) {
  if (err instanceof Error && err.message) return err.message;
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  try {
    const s = JSON.stringify(err);
    if (s && s !== "{}") return s;
  } catch {
    /* ignore */
  }
  return "Microsoft Edge TTS could not be reached. Check your network or firewall.";
}

type DialogueSegment = ReturnType<typeof parseDialogueScript>[number];

async function forwardAllTts(
  mode: "monologue" | "dialogue",
  dialogueSegments: DialogueSegment[],
  chunks: string[],
  voice: string,
  speakerVoices: Record<string, unknown>,
  rate: number,
  pitch: number,
  volume: number,
  onChunk: (chunk: Uint8Array) => void,
) {
  if (mode === "dialogue") {
    for (const segment of dialogueSegments) {
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
        onChunk,
      );
    }
    return;
  }

  for (const textChunk of chunks) {
    await pipeAudioStream(
      textChunk,
      voice,
      rate,
      pitch,
      volume,
      false,
      onChunk,
    );
  }
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
    const wantBuffer = body?.responseMode === "buffer";

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

    if (mode === "monologue" && chunks.length === 0) {
      return NextResponse.json(
        { error: "No speakable text found." },
        { status: 400 },
      );
    }

    if (mode === "dialogue" && dialogueSegments.length === 0) {
      return NextResponse.json(
        { error: "No dialogue lines found." },
        { status: 400 },
      );
    }

    if (wantBuffer) {
      const parts: Buffer[] = [];

      try {
        await forwardAllTts(
          mode,
          dialogueSegments,
          chunks,
          voice,
          speakerVoices,
          rate,
          pitch,
          volume,
          (chunk) => {
            parts.push(Buffer.from(chunk));
          },
        );
      } catch (err) {
        console.error("TTS error:", err);
        return NextResponse.json(
          { error: ttsFailureMessage(err) },
          { status: 502 },
        );
      }

      const audio = Buffer.concat(parts);
      if (audio.length === 0) {
        return NextResponse.json(
          { error: "No audio was generated." },
          { status: 502 },
        );
      }

      return new NextResponse(audio, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
        },
      });
    }

    const stream = new ReadableStream({
      async start(controller) {
        let failed = false;

        try {
          await forwardAllTts(
            mode,
            dialogueSegments,
            chunks,
            voice,
            speakerVoices,
            rate,
            pitch,
            volume,
            (chunk) => controller.enqueue(chunk),
          );
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
