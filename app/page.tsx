/* @ts-nocheck */
"use client";

import { useEffect, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { speak } from "@/lib/tts";
import { classifyDemo, type GestureLabel } from "@/lib/gesture";
import {
  scoreLetter,
  saveTemplate,
  clearTemplates,
  embedFromLandmarks,
} from "@/lib/fingerspell";
import { QuickPad } from "@/components/QuickPad";

type DetectState = { fps: number; hands: number };

export default function Home() {
  // DOM refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // keep last landmarks for template capture
  const lastLandmarksRef = useRef<any>(null);

  // UI state
  const [ready, setReady] = useState(false);
  const [det, setDet] = useState<DetectState>({ fps: 0, hands: 0 });
  const [currentText, setCurrentText] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(false); // default OFF to avoid spam
  const [fontSize, setFontSize] = useState(28);
  const [highContrast, setHighContrast] = useState(true);
  const [pushToSpeak, setPushToSpeak] = useState(false);

  // gesture gating + cooldowns
  const lastSpokenAtRef = useRef(0);
  const nextGestureAtRef = useRef(0);
  const lastLabelRef = useRef<GestureLabel | null>(null);
  const stableCountRef = useRef(0);
  const STABLE_FRAMES = 12; // ~0.4s @ 30fps
  const COOLDOWN_MS = 2000; // 2s between gestures
  const SPEAK_COOLDOWN = 1300;

  // push-to-speak (Space)
  const isHoldingRef = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        isHoldingRef.current = true;
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        isHoldingRef.current = false;
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // fingerspelling state/refs
  const [spell, setSpell] = useState("");
  const dwellLetterRef = useRef<string | null>(null);
  const dwellStartRef = useRef<number>(0);
  const lastLetterAtRef = useRef(0);
  const lastAppendedRef = useRef<string | null>(null);
  const HOLD_MS = 800;
  const REPEAT_COOLDOWN = 1400;

  // teach-a-letter 3s window
  const [capLetter, setCapLetter] = useState("A");
  const [capMsg, setCapMsg] = useState("");
  const captureWindowRef = useRef<{ until: number; key: string; saved: boolean } | null>(null);

  // init camera + model + safe loop
  useEffect(() => {
    const startedRef = { current: false };
    let landmarker: HandLandmarker | null = null;
    let raf = 0;
    let last = performance.now();

    async function init() {
      if (startedRef.current) return;
      startedRef.current = true;

      // 1) Camera
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;

      // wait for dimensions
      await new Promise<void>((resolve) => {
        const onMeta = () => {
          videoRef.current?.removeEventListener("loadedmetadata", onMeta);
          resolve();
        };
        videoRef.current?.addEventListener("loadedmetadata", onMeta);
      });
      await videoRef.current.play();

      // 2) Model (created directly in VIDEO mode)
      const resolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );
      landmarker = await HandLandmarker.createFromOptions(resolver, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        },
        numHands: 2,
        runningMode: "VIDEO",
      });

      // 3) Size canvas
      const resize = () => {
        if (!videoRef.current || !canvasRef.current) return;
        canvasRef.current.width = videoRef.current.videoWidth || 640;
        canvasRef.current.height = videoRef.current.videoHeight || 480;
      };
      resize();
      setReady(true);

      // 4) Safe loop
      const loop = () => {
        // wait for everything to exist; guard hot-reload nulls
        if (!videoRef.current || !canvasRef.current || !landmarker) {
          raf = requestAnimationFrame(loop);
          return;
        }

        const v = videoRef.current;

        // detect only when video has valid pixels
        const hasPixels =
          v &&
          v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          v.videoWidth > 0 &&
          v.videoHeight > 0 &&
          !v.paused &&
          !v.ended &&
          !document.hidden;

        if (!hasPixels) {
          raf = requestAnimationFrame(loop);
          return;
        }

        const now = performance.now();
        const dt = now - last;
        const fps = dt > 0 ? 1000 / dt : 0;
        last = now;

        let preds: any;
        try {
          preds = landmarker.detectForVideo(v, now);
          if (!preds) {
            raf = requestAnimationFrame(loop);
            return;
          }
        } catch {
          // skip this frame if detect threw
          raf = requestAnimationFrame(loop);
          return;
        }

        // keep latest landmarks for template capture
        lastLandmarksRef.current = preds?.landmarks ?? null;

        const ctx = canvasRef.current.getContext("2d");
        if (!ctx) {
          raf = requestAnimationFrame(loop);
          return;
        }

        // draw video
        ctx.drawImage(
          v,
          0,
          0,
          canvasRef.current.width,
          canvasRef.current.height
        );

        // draw landmarks
        ctx.lineWidth = 2;
        ctx.strokeStyle = highContrast ? "#00E" : "black";
        ctx.fillStyle = highContrast ? "#FFF" : "white";

        let hands = 0;
        if (preds?.landmarks) {
          hands = preds.landmarks.length;
          preds.landmarks.forEach((lm: any) => {
            lm.forEach((p: any) => {
              ctx.beginPath();
              ctx.arc(
                p.x * canvasRef.current!.width,
                p.y * canvasRef.current!.height,
                3,
                0,
                Math.PI * 2
              );
              ctx.fill();
              ctx.stroke();
            });
          });
        }
        setDet({ fps, hands });

        // ---------- (1) Gestures -> phrase (stable + 2s cooldown)
        if (now >= nextGestureAtRef.current) {
          const hit = classifyDemo(preds.landmarks as any); // may be null
          if (hit) {
            const same = hit.label === lastLabelRef.current;
            stableCountRef.current = same ? stableCountRef.current + 1 : 1;
            lastLabelRef.current = hit.label;
          } else {
            stableCountRef.current = 0;
            lastLabelRef.current = null;
          }

          if (lastLabelRef.current && stableCountRef.current >= STABLE_FRAMES) {
            const phrase = labelToPhrase(lastLabelRef.current);
            setCurrentText(phrase);

            const canSpeak = autoSpeak && (!pushToSpeak || isHoldingRef.current);
            if (canSpeak && now - lastSpokenAtRef.current > SPEAK_COOLDOWN) {
              speak(phrase);
              lastSpokenAtRef.current = now;
            }
            nextGestureAtRef.current = now + COOLDOWN_MS; // block new gesture for 2s
            stableCountRef.current = 0;
            lastLabelRef.current = null;
          }
        }

        // ---------- (2) Fingerspelling (dwell + anti-duplicate)
        const L = scoreLetter(preds.landmarks as any); // {letter, score} | null
        if (L) {
          if (L.letter !== dwellLetterRef.current) {
            dwellLetterRef.current = L.letter;
            dwellStartRef.current = now;
          } else {
            const held = now - dwellStartRef.current;
            const sameTooSoon =
              lastAppendedRef.current === L.letter &&
              now - lastLetterAtRef.current < REPEAT_COOLDOWN;
            if (held >= HOLD_MS && !sameTooSoon) {
              setSpell((s) => (s + L.letter).toLowerCase());
              lastLetterAtRef.current = now;
              lastAppendedRef.current = L.letter;
              dwellStartRef.current = now + 9999; // force re-hold
            }
          }
        } else {
          dwellLetterRef.current = null;
        }

        // ---------- (3) Teach-a-letter capture window (save best frame)
        if (captureWindowRef.current) {
          if (now <= captureWindowRef.current.until) {
            if (lastLandmarksRef.current && !captureWindowRef.current.saved) {
              const emb = embedFromLandmarks(lastLandmarksRef.current);
              if (emb) {
                saveTemplate(captureWindowRef.current.key, emb);
                captureWindowRef.current.saved = true;
                setCapMsg(`Saved template for ${captureWindowRef.current.key}`);
              }
            }
          } else {
            if (!captureWindowRef.current.saved) setCapMsg("Capture timed out");
            captureWindowRef.current = null;
          }
        }

        raf = requestAnimationFrame(loop);
      };

      raf = requestAnimationFrame(loop);
    }

    init();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      const s = videoRef.current?.srcObject as MediaStream | undefined;
      s?.getTracks().forEach((t) => t.stop());
      // @ts-ignore
      landmarker?.close?.();
    };
    // keep deps minimal so we don't re-init constantly
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highContrast]);

  // speak current text once
  const say = () => currentText && speak(currentText);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">SignSidecar</h1>
        <div className="text-xs text-gray-500">
          FPS: {det.fps.toFixed(1)} • Hands: {det.hands}
        </div>
      </header>

      <div className="grid md:grid-cols-[2fr_1fr] gap-4 items-start">
        {/* Video */}
        <div className="relative rounded-2xl overflow-hidden shadow ring-1 ring-gray-200">
          <video ref={videoRef} className="hidden" playsInline muted />
          <canvas ref={canvasRef} className="w-full h-auto bg-black" />
          {!ready && (
            <div className="absolute inset-0 grid place-items-center text-white text-lg">
              Allow camera…
            </div>
          )}
          <div
            className={`absolute bottom-0 left-0 right-0 p-3 ${
              highContrast ? "bg-black/70 text-white" : "bg-white/80 text-gray-900"
            }`}
          >
            <div
              className="font-semibold truncate"
              style={{ fontSize: `${fontSize}px`, lineHeight: 1.15 }}
              title={currentText}
            >
              {currentText || "…"}
            </div>
          </div>
        </div>

        {/* Controls */}
        <aside className="p-4 bg-white rounded-2xl shadow space-y-3 border border-gray-100">
          <div className="text-lg font-semibold">Controls</div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoSpeak}
              onChange={(e) => setAutoSpeak(e.target.checked)}
            />
            Auto-speak recognized phrase
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={pushToSpeak}
              onChange={(e) => setPushToSpeak(e.target.checked)}
            />
            Push to speak (hold Space)
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={highContrast}
              onChange={(e) => setHighContrast(e.target.checked)}
            />
            High-contrast overlay
          </label>

          <div className="text-sm">Caption size: {fontSize}px</div>
          <input
            type="range"
            min={20}
            max={48}
            value={fontSize}
            onChange={(e) => setFontSize(parseInt(e.target.value))}
            className="w-full"
          />

          <div className="flex gap-2">
            <button
              onClick={say}
              className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
            >
              Speak Again
            </button>
            <button
              onClick={() => setCurrentText("")}
              className="px-3 py-2 rounded-lg bg-gray-100 text-gray-800 text-sm font-medium hover:bg-gray-200"
            >
              Clear
            </button>
          </div>

          {/* Quick phrases */}
          <QuickPad onPick={(p) => setCurrentText(p)} />

          <hr className="my-3" />

          {/* Fingerspelling buffer */}
          <div className="space-y-2">
            <div className="text-sm font-medium text-gray-700">Fingerspelling</div>
            <div className="flex gap-2">
              <input
                value={spell}
                onChange={(e) => setSpell(e.target.value.toLowerCase())}
                className="flex-1 border rounded-lg px-2 py-2 text-sm"
                placeholder="letters will appear here…"
              />
              <button
                onClick={() => {
                  const w = spell.trim();
                  if (w) {
                    setCurrentText(w);
                    speak(w);
                  }
                }}
                className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700"
              >
                Speak word
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setSpell((s) => s.slice(0, -1))}
                className="px-2 py-1 rounded bg-gray-100 text-xs hover:bg-gray-200"
              >
                Backspace
              </button>
              <button
                onClick={() => setSpell("")}
                className="px-2 py-1 rounded bg-gray-100 text-xs hover:bg-gray-200"
              >
                Clear
              </button>
            </div>
            <div className="text-xs text-gray-500">
              Hold a letter steady ~0.8s to append. Avoid repeats within ~1.4s.
              Teach letters below for best accuracy.
            </div>
          </div>

          <hr className="my-3" />

          {/* Teach a letter */}
          <div className="space-y-2">
            <div className="text-sm font-medium text-gray-700">Teach a letter</div>
            <div className="flex gap-2">
              <input
                maxLength={1}
                value={capLetter}
                onChange={(e) => setCapLetter(e.target.value.toUpperCase())}
                className="w-16 border rounded-lg px-2 py-2 text-sm text-center"
              />
              <button
                onClick={() => {
                  captureWindowRef.current = {
                    until: performance.now() + 3000,
                    key: capLetter.toUpperCase(),
                    saved: false,
                  };
                  setCapMsg("Hold the letter steady ~1s…");
                }}
                className="px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
              >
                Capture 3s window
              </button>
              <button
                onClick={() => {
                  clearTemplates();
                  setCapMsg("Templates cleared");
                }}
                className="px-3 py-2 rounded-lg bg-gray-100 text-gray-800 text-sm font-medium hover:bg-gray-200"
              >
                Reset
              </button>
            </div>
            {capMsg && <div className="text-xs text-gray-500">{capMsg}</div>}
          </div>

          <hr />
          <div className="text-xs text-gray-500">
            Runs fully in-browser; no video uploaded. Good lighting improves accuracy.
          </div>
        </aside>
      </div>
    </div>
  );
}

function labelToPhrase(l: GestureLabel): string {
  switch (l) {
    case "question":
      return "I have a question.";
    case "yes":
      return "Yes.";
    case "no":
      return "No.";
    case "thank you":
      return "Thank you.";
    case "next slide":
      return "Next slide, please.";
    default:
      return "";
  }
}
