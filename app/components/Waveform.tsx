"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type WaveformProps = {
  src: string;
  autoPlay?: boolean;
};

const BAR_COUNT = 60;
const DECAY = 0.88;

function formatTime(value: number) {
  if (!Number.isFinite(value)) return "0:00";

  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function getCanvasColor(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;

  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

export function Waveform({ src, autoPlay = false }: WaveformProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const levelsRef = useRef<number[]>(Array(BAR_COUNT).fill(0.08));
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const draw = useCallback((active = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const rect = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);

    if (canvas.width !== Math.floor(width * pixelRatio)) {
      canvas.width = Math.floor(width * pixelRatio);
    }

    if (canvas.height !== Math.floor(height * pixelRatio)) {
      canvas.height = Math.floor(height * pixelRatio);
    }

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    const accent = getCanvasColor("--accent", "#b4543a");
    const muted = getCanvasColor("--border", "#d4c9b2");
    const gap = 3;
    const barWidth = Math.max(2, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT);
    const center = height / 2;
    const data = new Uint8Array(analyserRef.current?.frequencyBinCount || 0);

    if (active && analyserRef.current) {
      analyserRef.current.getByteFrequencyData(data);
    }

    for (let index = 0; index < BAR_COUNT; index += 1) {
      const bucketStart = Math.floor((index / BAR_COUNT) * data.length);
      const bucketEnd = Math.max(
        bucketStart + 1,
        Math.floor(((index + 1) / BAR_COUNT) * data.length),
      );
      let total = 0;

      for (let bucket = bucketStart; bucket < bucketEnd; bucket += 1) {
        total += data[bucket] || 0;
      }

      const target = active ? total / (bucketEnd - bucketStart) / 255 : 0.08;
      levelsRef.current[index] = active
        ? Math.max(target, levelsRef.current[index] * DECAY)
        : levelsRef.current[index];

      const level = levelsRef.current[index];
      const barHeight = Math.max(4, level * (height - 8));
      const x = index * (barWidth + gap);
      const y = center - barHeight / 2;

      context.fillStyle = active ? accent : muted;
      context.globalAlpha = active ? 0.9 : 0.55;
      context.fillRect(x, y, barWidth, barHeight);
    }

    context.globalAlpha = 1;
  }, []);

  const stopAnimation = useCallback(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const animate = useCallback(() => {
    draw(true);
    animationRef.current = requestAnimationFrame(animate);
  }, [draw]);

  const ensureAudioGraph = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return null;

    if (audioContextRef.current?.state === "closed") {
      sourceRef.current = null;
      analyserRef.current = null;
      audioContextRef.current = null;
    }

    if (!audioContextRef.current) {
      const AudioContextConstructor =
        window.AudioContext ||
        (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext;

      if (!AudioContextConstructor) return null;

      const audioContext = new AudioContextConstructor({
        latencyHint: "interactive",
      });
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;

      const source = audioContext.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(audioContext.destination);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      sourceRef.current = source;
    }

    return audioContextRef.current;
  }, []);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    const audioContext = ensureAudioGraph();
    if (!audio || !audioContext) return;

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    await audio.play();
  }, [ensureAudioGraph]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      void play();
    } else {
      audio.pause();
    }
  }, [play]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver(() => draw(playing));
    observer.observe(canvas);
    draw(false);

    return () => observer.disconnect();
  }, [draw, playing]);

  useEffect(() => {
    const source = sourceRef.current;
    const audio = audioRef.current;

    if (source && audio && source.mediaElement !== audio) {
      console.warn(
        "Waveform audio graph is bound to a stale audio element; playback may need a graph reset.",
      );
    }

    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    levelsRef.current = Array(BAR_COUNT).fill(0.08);
    stopAnimation();
    draw(false);
  }, [draw, src, stopAnimation]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleLoadedMetadata = () => {
      setDuration(audio.duration || 0);
      setCurrentTime(audio.currentTime || 0);
    };
    const handleTimeUpdate = () => setCurrentTime(audio.currentTime || 0);
    const handlePlay = () => {
      setPlaying(true);
      stopAnimation();
      animate();
    };
    const handlePause = () => {
      setPlaying(false);
      stopAnimation();
      draw(false);
    };
    const handleEnded = () => {
      setPlaying(false);
      setCurrentTime(0);
      levelsRef.current = Array(BAR_COUNT).fill(0.08);
      stopAnimation();
      draw(false);
    };

    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [animate, draw, stopAnimation]);

  useEffect(() => {
    return () => {
      stopAnimation();
      sourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      const audioContext = audioContextRef.current;
      sourceRef.current = null;
      analyserRef.current = null;
      audioContextRef.current = null;

      if (audioContext && audioContext.state !== "closed") {
        audioContext.close().catch(() => {
          /* Closing can reject if the context is already shutting down. */
        });
      }
    };
  }, [stopAnimation]);

  return (
    <div className="waveform-player">
      <audio ref={audioRef} src={src} preload="metadata" autoPlay={autoPlay} />
      <button
        className="waveform-play"
        type="button"
        onClick={togglePlayback}
        aria-label={playing ? "Pause audio" : "Play audio"}
      >
        {playing ? (
          <svg
            aria-hidden
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M7 5h4v14H7z" />
            <path d="M13 5h4v14h-4z" />
          </svg>
        ) : (
          <svg
            aria-hidden
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <div className="waveform-main">
        <div className="waveform-topline">
          <canvas className="waveform-canvas" ref={canvasRef} />
          <div className="waveform-time">
            {formatTime(currentTime)} / {formatTime(duration)}
          </div>
        </div>
        <input
          className="waveform-scrub"
          type="range"
          min="0"
          max={duration > 0 ? duration : 1}
          step="0.01"
          value={Math.min(currentTime, duration || 0)}
          disabled={duration === 0}
          onChange={(event) => {
            const nextTime = Number(event.target.value);
            if (audioRef.current) {
              audioRef.current.currentTime = nextTime;
            }
            setCurrentTime(nextTime);
          }}
          aria-label="Scrub audio"
        />
      </div>
    </div>
  );
}
