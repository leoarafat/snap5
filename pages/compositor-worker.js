/* Combines screen, crop and camera into one video track. Runs in a worker so that
   Chrome's background-tab timer throttling cannot make the recording stutter. */
const latest = { screen: null, camera: null };
const readers = [];
let canvas;
let ctx;
let writer;
let timer;
let layout;
let stopped = false;

const pump = async (readable, key) => {
  const reader = readable.getReader();
  readers.push(reader);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (stopped) {
        value.close();
        break;
      }
      latest[key]?.close();
      latest[key] = value;
    }
  } catch {}
};

/* Draws the part `src` of a frame into `dst`, keeping the aspect ratio (letterbox). */
const contain = (frame, src, dst) => {
  const k = Math.min(dst.w / src.w, dst.h / src.h);
  const w = src.w * k;
  const h = src.h * k;
  ctx.drawImage(frame, src.x, src.y, src.w, src.h, dst.x + (dst.w - w) / 2, dst.y + (dst.h - h) / 2, w, h);
};

const drawBubble = (frame, cam) => {
  const fw = frame.displayWidth;
  const fh = frame.displayHeight;
  const wide = cam.shape === 'wide';
  const w = Math.round(cam.size * canvas.width);
  const h = Math.round(wide ? (w * 9) / 16 : w);
  const x = Math.round(cam.x * (canvas.width - w));
  const y = Math.round(cam.y * (canvas.height - h));
  // Centre-crop the camera to the bubble's shape.
  let sw = fw;
  let sh = (fw * h) / w;
  if (sh > fh) {
    sh = fh;
    sw = (fh * w) / h;
  }
  const path = () => {
    ctx.beginPath();
    if (cam.shape === 'circle') ctx.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2);
    else ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.12);
  };
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.45)';
  ctx.shadowBlur = w * 0.08;
  ctx.fillStyle = '#000';
  path();
  ctx.fill();
  ctx.restore();
  ctx.save();
  path();
  ctx.clip();
  if (cam.mirror) {
    ctx.translate(2 * x + w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(frame, (fw - sw) / 2, (fh - sh) / 2, sw, sh, x, y, w, h);
  ctx.restore();
  ctx.lineWidth = Math.max(2, w * 0.012);
  ctx.strokeStyle = 'rgba(255,255,255,.92)';
  path();
  ctx.stroke();
};

const tick = () => {
  const base = layout.cameraOnly ? latest.camera : latest.screen;
  if (!base) return;
  const full = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const crop = layout.crop || { x: 0, y: 0, w: 1, h: 1 };
  const src = { x: crop.x * base.displayWidth, y: crop.y * base.displayHeight, w: crop.w * base.displayWidth, h: crop.h * base.displayHeight };
  if (layout.cameraOnly && layout.camera.mirror) {
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    contain(base, src, full);
    ctx.restore();
  } else contain(base, src, full);

  if (!layout.cameraOnly && latest.camera && layout.camera?.visible) drawBubble(latest.camera, layout.camera);

  if (writer.desiredSize !== null && writer.desiredSize <= 0) return; // encoder is busy: skip a frame
  const frame = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
  writer.write(frame).catch(() => frame.close());
};

self.onmessage = ({ data }) => {
  if (data.type === 'start') {
    canvas = new OffscreenCanvas(data.width, data.height);
    ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingQuality = 'high';
    writer = data.writable.getWriter();
    layout = data.layout;
    if (data.screen) pump(data.screen, 'screen');
    if (data.camera) pump(data.camera, 'camera');
    timer = setInterval(() => {
      try {
        tick();
      } catch (error) {
        self.postMessage({ type: 'error', message: error.message });
      }
    }, 1000 / data.fps);
  } else if (data.type === 'layout') {
    layout = data.layout;
  } else if (data.type === 'stop') {
    stopped = true;
    clearInterval(timer);
    readers.forEach((r) => r.cancel().catch(() => {}));
    latest.screen?.close();
    latest.camera?.close();
    latest.screen = latest.camera = null;
    writer?.close().catch(() => {});
    self.close();
  }
};
