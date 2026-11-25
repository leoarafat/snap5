/* Video file helpers: thumbnails, WebM duration, seeking and trimming. */
(() => {
  const S = (globalThis.Snap5 ||= {});

  const once = (target, name) => new Promise((resolve) => target.addEventListener(name, resolve, { once: true }));
  const timeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('video timed out')), ms))]);

  S.formatTime = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  S.formatSize = (bytes) => (bytes < 1e6 ? `${Math.round(bytes / 1e3)} KB` : bytes < 1e9 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e9).toFixed(2)} GB`);

  /* Live recordings have no index, so Chrome may report an endless duration until it scans the end. */
  S.makeSeekable = async (video) => {
    if (video.readyState < 1) await timeout(once(video, 'loadedmetadata'), 15000);
    if (Number.isFinite(video.duration)) return;
    const scanned = new Promise((resolve) => {
      const check = () => {
        if (!Number.isFinite(video.duration)) return;
        video.removeEventListener('durationchange', check);
        resolve();
      };
      video.addEventListener('durationchange', check);
    });
    video.currentTime = 1e101;
    await timeout(scanned, 15000).catch(() => {});
    video.currentTime = 0;
  };

  S.seek = async (video, seconds) => {
    const done = once(video, 'seeked');
    video.currentTime = seconds;
    await timeout(done, 8000);
  };

  S.videoThumb = async (blob) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(blob);
    try {
      video.muted = true;
      video.preload = 'auto';
      video.src = url;
      await S.makeSeekable(video);
      await S.seek(video, Math.min(1, (Number.isFinite(video.duration) ? video.duration : 2) / 2));
      const canvas = document.createElement('canvas');
      canvas.width = 360;
      canvas.height = Math.max(1, Math.round((360 * video.videoHeight) / video.videoWidth));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
  };

  /* Chrome writes WebM files without a duration. This adds it to the Info block. */
  S.fixWebmDuration = async (blob, durationMs) => {
    const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    const find = (id, from, to) => {
      for (let i = from; i <= to - id.length; i++) if (id.every((b, k) => head[i + k] === b)) return i;
      return -1;
    };
    const info = find([0x15, 0x49, 0xa9, 0x66], 0, head.length);
    if (info < 0 || !(durationMs > 0)) return blob;
    const sizeAt = info + 4;
    let length = 1;
    while (length <= 8 && !(head[sizeAt] & (0x80 >> (length - 1)))) length++;
    if (length > 8) return blob;
    let size = head[sizeAt] & (0xff >> length);
    for (let i = 1; i < length; i++) size = size * 256 + head[sizeAt + i];
    const body = sizeAt + length;
    if (body + size > head.length || find([0x44, 0x89], body, body + size) >= 0) return blob;

    const duration = new Uint8Array(11);
    duration.set([0x44, 0x89, 0x88]);
    new DataView(duration.buffer).setFloat64(3, durationMs); // timecode scale is 1 ms
    const newSize = new Uint8Array(8);
    let value = size + duration.length;
    for (let i = 7; i >= 1; i--) {
      newSize[i] = value % 256;
      value = Math.floor(value / 256);
    }
    newSize[0] = 0x01;
    return new Blob([blob.slice(0, sizeAt), newSize, blob.slice(body, body + size), duration, blob.slice(body + size)], { type: blob.type });
  };

  /* Cuts a clip by replaying it into a new recording. Takes as long as the clip itself. */
  S.trimVideo = async (blob, { start, end, ext, onProgress, signal }) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(blob);
    let audio;
    try {
      video.preload = 'auto';
      video.src = url;
      video.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none';
      document.body.append(video);
      await S.makeSeekable(video);
      await S.seek(video, start);

      // Route the sound into the new file only, not to the speakers.
      audio = new AudioContext({ sampleRate: 48000 });
      await audio.resume();
      const mix = audio.createMediaStreamDestination();
      audio.createMediaElementSource(video).connect(mix);

      const picture = video.captureStream();
      const stream = new MediaStream([...picture.getVideoTracks(), ...mix.stream.getAudioTracks()]);
      const mime = S.pickMime(ext, true);
      const bits = Math.min(40e6, Math.max(2e6, (blob.size * 8) / Math.max(1, video.duration || end)));
      const parts = [];
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(bits) });
      recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      await video.play();
      recorder.start(500);

      await new Promise((resolve, reject) => {
        const watch = setInterval(() => {
          onProgress?.(Math.min(1, (video.currentTime - start) / (end - start)));
          if (signal?.aborted) {
            clearInterval(watch);
            reject(new Error('cancelled'));
          } else if (video.currentTime >= end || video.ended) {
            clearInterval(watch);
            resolve();
          }
        }, 30);
      }).finally(() => {
        video.pause();
        if (recorder.state !== 'inactive') recorder.stop();
      });
      await stopped;
      let out = new Blob(parts, { type: mime.split(';')[0] });
      const outExt = mime.includes('mp4') ? 'mp4' : 'webm';
      if (outExt === 'webm') out = await S.fixWebmDuration(out, (end - start) * 1000);
      return { blob: out, ext: outExt, mime, duration: (end - start) * 1000 };
    } finally {
      video.remove();
      video.removeAttribute('src');
      audio?.close().catch(() => {});
      URL.revokeObjectURL(url);
    }
  };
})();
