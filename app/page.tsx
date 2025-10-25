"use client";

import { useEffect, useRef, useState } from "react";
import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { speak } from "@/lib/tts";
import { classifyDemo, type GestureLabel } from "@/lib/gesture";


type DetectResult = {
  landmarks: NormalizedLandmark[][];
  fps: number;
  hands: number;
};

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<DetectResult>({
    landmarks: [],
    fps: 0,
    hands: 0,
  });
  const [currentText, setCurrentText] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [fontSize, setFontSize] = useState(28);
  const [highContrast, setHighContrast] = useState(true);
  const [lastSpokenAt, setLastSpokenAt] = useState(0);

 
  useEffect(() => {
    let landmarker: HandLandmarker | null = null;
    let raf = 0;
    let last = performance.now();

    async function init() {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

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

      setReady(true);

      const loop = () => {
        if (!videoRef.current || !canvasRef.current || !landmarker) return;

        const now = performance.now();
        const dt = now - last;
        const fps = dt > 0 ? 1000 / dt : 0;
        last = now;

        const predictions = landmarker.detectForVideo(videoRef.current, now);
        const ctx = canvasRef.current.getContext("2d");
        if (!ctx) return;


        ctx.drawImage(
          videoRef.current,
          0,
          0,
          canvasRef.current.width,
          canvasRef.current.height
        );
        ctx.lineWidth = 2;
        ctx.strokeStyle = highContrast ? "#00E" : "black";
        ctx.fillStyle = highContrast ? "#FFF" : "white";

        let totalHands = 0;
        if (predictions.landmarks) {
          totalHands = predictions.landmarks.length;
          predictions.landmarks.forEach((lm) => {
            lm.forEach((p) => {
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

        setResult({
          landmarks: predictions.landmarks ?? [],
          fps,
          hands: totalHands,
        });

        
        const label = classifyDemo(predictions.landmarks ?? []);
        if (label) {
          const phrase = labelToPhrase(label);
          
          setCurrentText(phrase);
          
          if (autoSpeak && now - lastSpokenAt > 1200) {
            speak(phrase);
            setLastSpokenAt(now);
          }
        }

        raf = requestAnimationFrame(loop);
      };

      const resize = () => {
        if (!videoRef.current || !canvasRef.current) return;
        canvasRef.current.width = videoRef.current.videoWidth || 640;
        canvasRef.current.height = videoRef.current.videoHeight || 480;
      };
      videoRef.current.addEventListener("loadedmetadata", resize);
      resize();
      raf = requestAnimationFrame(loop);
    }

    init();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (videoRef.current?.srcObject) {
        (videoRef.current.srcObject as MediaStream)
          .getTracks()
          .forEach((t) => t.stop());
      }
    };
  }, [autoSpeak, highContrast, lastSpokenAt]);

  // helpers
  const say = () => currentText && speak(currentText);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">SignSidecar</h1>
        <div className="text-xs text-gray-500">
          FPS: {result.fps.toFixed(1)} • Hands: {result.hands}
        </div>
      </header>

      <div className="grid md:grid-cols-[2fr_1fr] gap-4 items-start">
        {/* Video panel */}
        <div className="relative rounded-2xl overflow-hidden shadow ring-1 ring-gray-200">
          <video ref={videoRef} className="hidden" playsInline muted />
          <canvas ref={canvasRef} className="w-full h-auto bg-black" />
          {!ready && (
            <div className="absolute inset-0 grid place-items-center text-white text-lg">
              Allow camera access…
            </div>
          )}
          {/* HUD caption */}
          <div
            className={`absolute bottom-0 left-0 right-0 p-3 ${
              highContrast
                ? "bg-black/70 text-white"
                : "bg-white/80 text-gray-900"
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

        {/* Control panel */}
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

          <div className="text-xs text-gray-500">
            Tip: keep hands centered; good lighting improves stability.
          </div>

          <hr />
          <div className="text-xs text-gray-500">
            Demo classifier is heuristic. We’ll swap in a trained model for the
            final.
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
