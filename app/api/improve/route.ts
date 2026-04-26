import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM_PROMPT =
  "You rewrite text to sound natural when spoken aloud. Expand contractions thoughtfully, break long sentences, add natural pauses with commas, remove parenthetical asides that confuse listeners, replace 'e.g.' with 'for example', spell out 'vs' as 'versus', etc. Return only the rewritten text — no commentary, no quotes around it.";

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
