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
