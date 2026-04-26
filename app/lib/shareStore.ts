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
