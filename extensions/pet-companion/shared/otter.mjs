export function createOtter(canvas, image, signal) {
  canvas.width = 384;
  canvas.height = 416;
  const context = canvas.getContext("2d");
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let status = "idle";
  let started = 0;
  let last = -Infinity;
  let request;
  let stopped = false;
  const draw = (time) => {
    if (stopped || signal?.aborted) return;
    if (time - last >= 80 && !canvas.ownerDocument.hidden) {
      last = time;
      const elapsed = reduced ? 0 : (time - started) / 1000;
      const phase = elapsed * Math.PI * 2;
      let lift = 2 * Math.sin(phase / 4);
      let tilt = 0;
      let stretch = 1 + 0.008 * Math.sin(phase / 4);
      if (status === "working") {
        lift = 3 * Math.sin(phase * 1.5);
        tilt = 0.018 * Math.sin(phase * 1.5);
      } else if (status === "waiting") {
        tilt = -0.08 + 0.018 * Math.sin(phase / 2);
      } else if (status === "success") {
        lift = 14 * Math.abs(Math.sin(phase / 1.8));
        stretch = 1 - 0.025 * Math.cos(phase / 0.9);
      } else if (status === "error") {
        tilt = 0.045 * Math.sin(phase * 2.5) * Math.max(0, 1 - elapsed / 2);
      }
      context.clearRect(0, 0, 384, 416);
      context.save();
      context.translate(192, 396 - lift);
      context.rotate(tilt);
      context.scale(1, stretch);
      context.shadowColor = "#f4f5f7";
      context.shadowBlur = 3;
      context.drawImage(image, -168, -352, 336, 336);
      context.restore();
    }
    request = requestAnimationFrame(draw);
  };
  const dispose = () => {
    stopped = true;
    cancelAnimationFrame(request);
    context.clearRect(0, 0, 384, 416);
  };
  const still = (avatar) => {
    const frame = canvas.ownerDocument.createElement("canvas");
    frame.width = avatar ? 64 : 192;
    frame.height = avatar ? 64 : 208;
    const painter = frame.getContext("2d");
    if (avatar) {
      painter.fillStyle = "#f4f5f7";
      painter.beginPath();
      painter.arc(32, 32, 31, 0, Math.PI * 2);
      painter.fill();
      painter.drawImage(image, 60, 0, 210, 210, 2, 2, 60, 60);
      painter.fillStyle = "#f47364";
      painter.beginPath();
      painter.arc(54, 10, 9, 0, Math.PI * 2);
      painter.fill();
      painter.strokeStyle = "#fff";
      painter.lineWidth = 3;
      painter.stroke();
    } else {
      painter.drawImage(image, 8, 16, 176, 176);
    }
    return frame.toDataURL("image/png");
  };
  draw(0);
  signal?.addEventListener("abort", dispose, { once: true });
  return {
    setState(value) {
      if (value !== status) {
        status = value;
        started = performance.now();
        last = -Infinity;
      }
    },
    thumbnail: () => still(false),
    avatar: () => still(true),
    dispose() {
      signal?.removeEventListener("abort", dispose);
      dispose();
    },
  };
}
