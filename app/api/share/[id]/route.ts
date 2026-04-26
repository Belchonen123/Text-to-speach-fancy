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
