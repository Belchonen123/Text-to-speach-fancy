import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Use https://your-deployment.vercel.app/api/health to confirm functions deploy. */
export function GET() {
  return NextResponse.json({ ok: true, service: "tts-app" });
}
