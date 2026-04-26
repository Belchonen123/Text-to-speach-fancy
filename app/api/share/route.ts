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
