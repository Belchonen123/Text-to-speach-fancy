import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Waveform } from "@/app/components/Waveform";
import { getInlineShare, getStoredShare } from "@/app/lib/shareStore";

type SharePageProps = {
  params: {
    id: string;
  };
  searchParams: {
    audio?: string;
    text?: string;
    voice?: string;
  };
};

async function loadShare({ params, searchParams }: SharePageProps) {
  if (params.id === "inline") {
    return getInlineShare(searchParams);
  }

  return getStoredShare(params.id);
}

export async function generateMetadata(
  props: SharePageProps,
): Promise<Metadata> {
  const share = await loadShare(props);
  const title = share
    ? `${share.text.slice(0, 80)}${share.text.length > 80 ? "..." : ""}`
    : "Shared TTS audio";

  return {
    title,
    description: "A generated audio clip from Free TTS Studio.",
    openGraph: {
      title,
      description: "Listen to this generated audio clip.",
      type: "music.song",
    },
    twitter: {
      card: "summary",
      title,
      description: "Listen to this generated audio clip.",
    },
  };
}

export default async function SharePage(props: SharePageProps) {
  const share = await loadShare(props);

  if (!share) {
    notFound();
  }

  const audioSrc =
    share.audioBase64 ??
    `/api/share/${share.id}`;

  return (
    <main className="share-page">
      <section className="share-card">
        <div className="eyebrow">Shared Audio</div>
        <p className="share-text">{share.text}</p>
        <div className="share-player">
          <Waveform src={audioSrc} />
        </div>
      </section>
      <footer className="share-footer">
        Created with <Link href="/">Free TTS Studio</Link>
      </footer>
    </main>
  );
}
