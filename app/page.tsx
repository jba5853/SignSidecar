"use client";

import { useEffect, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);
  const [hands, setHands] = useState<number>(0);
  const [fps, setFps] = useState<number>(0);

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
        if (dt > 0) setFps(1000 / dt);
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
        ctx.strokeStyle = "black";
        ctx.fillStyle = "white";

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
        setHands(totalHands);

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
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">SignSidecar (MVP)</h1>
      <p className="text-sm text-gray-600">
        Webcam → Hand landmarks (on-device). Next: classify gestures & speak
        them.
      </p>

      <div className="grid md:grid-cols-[2fr_1fr] gap-4 items-start">
        <div className="relative rounded-2xl overflow-hidden shadow">
          <video ref={videoRef} className="hidden" playsInline muted />
          <canvas ref={canvasRef} className="w-full h-auto bg-black" />
          {!ready && (
            <div className="absolute inset-0 grid place-items-center text-white text-lg">
              Allow camera access…
            </div>
          )}
        </div>

        <div className="p-4 bg-white rounded-2xl shadow space-y-2">
          <div className="text-lg font-semibold">Status</div>
          <div className="text-sm">Camera: {ready ? "ready" : "waiting"}</div>
          <div className="text-sm">Hands detected: {hands}</div>
          <div className="text-sm">FPS: {fps.toFixed(1)}</div>
          <hr className="my-2" />
          <div className="text-sm">
            <b>Tip:</b> good lighting, hands within frame, palms toward camera
            for stable landmarks.
          </div>
        </div>
      </div>
    </div>
  );
}
