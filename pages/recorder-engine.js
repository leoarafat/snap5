/* Screen / camera recording engine: capture, audio mixing, compositing and crash-safe saving. */
(() => {
  const S = (globalThis.Snap5 ||= {});

  const MIME = {
    mp4: { av: ['video/mp4;codecs=avc1.640034,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'], v: ['video/mp4;codecs=avc1.640034', 'video/mp4'] },
    webm: { av: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'], v: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'] },
  };
  const BITS_PER_PIXEL = { standard: 0.06, high: 0.11, best: 0.18 };
  const SIZES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] };

  const pickMime = (format, hasAudio) => {
    const wanted = MIME[format] || MIME.mp4;
    return [...wanted[hasAudio ? 'av' : 'v'], ...MIME.webm[hasAudio ? 'av' : 'v']].find((m) => MediaRecorder.isTypeSupported(m));
  };

  /* Walks the top-level boxes of an MP4 file. */
  const containsBox = async (blob, type) => {
    for (let at = 0; at + 8 <= blob.size; ) {
      const head = new DataView(await blob.slice(at, at + 16).arrayBuffer());
      const name = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
      if (name === type) return true;
      let size = head.getUint32(0);
      if (size === 1 && head.byteLength >= 16) size = Number(head.getBigUint64(8));
      if (size < 8) break;
      at += size;
    }
    return false;
  };

  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const stopTracks = (stream) => stream?.getTracks().forEach((t) => t.stop());

  /* A video element is the dependable way to learn a track's real frame size. */
  const frameSize = async (track) => {
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = new MediaStream([track]);
    await video.play().catch(() => {});
    for (let i = 0; i < 40 && !video.videoWidth; i++) await new Promise((r) => setTimeout(r, 50));
    const set = track.getSettings();
    const size = { width: video.videoWidth || set.width || 1280, height: video.videoHeight || set.height || 720 };
    video.srcObject = null;
    return size;
  };

  class Recording extends EventTarget {
    constructor(options) {
      super();
      this.options = options;
      this.state = 'idle';
      this.display = null;
      this.mic = null;
      this.camera = null;
      this.size = 0;
      this.elapsedBefore = 0;
      this.resumedAt = 0;
      this.writes = Promise.resolve();
      this.micMuted = false;
      this.cameraVisible = true;
    }

    emit(name, detail) {
      this.dispatchEvent(new CustomEvent(name, { detail }));
    }

    setState(state) {
      this.state = state;
      this.emit('state', state);
    }

    get elapsed() {
      return this.elapsedBefore + (this.state === 'recording' ? performance.now() - this.resumedAt : 0);
    }

    /* Must be called straight from a click: Chrome only opens its picker then. */
    async pickScreen() {
      const o = this.options;
      const size = SIZES[o.resolution];
      const controller = window.CaptureController ? new CaptureController() : undefined;
      this.display = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: o.surface,
          frameRate: { ideal: o.fps, max: o.fps },
          ...(size ? { width: { max: size[0] }, height: { max: size[1] } } : {}),
          cursor: 'always',
        },
        audio: o.systemAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false } : false,
        systemAudio: o.systemAudio ? 'include' : 'exclude',
        surfaceSwitching: 'include',
        selfBrowserSurface: 'exclude',
        monitorTypeSurfaces: 'include',
        ...(controller ? { controller } : {}),
      });
      const track = this.display.getVideoTracks()[0];
      this.surface = track.getSettings().displaySurface || o.surface;
      try {
        // Jump to the shared tab or window, except when a region still has to be drawn here.
        if (this.surface !== 'monitor') controller?.setFocusBehavior(o.region ? 'no-focus-change' : 'focus-captured-surface');
      } catch {}
      track.addEventListener('ended', () => {
        if (this.state === 'recording' || this.state === 'paused') this.stop();
        else this.emit('cancelled');
      });
      return this.display;
    }

    cameraLayout() {
      const c = this.options.cameraLayout;
      return { shape: c.shape, size: c.size, x: c.x, y: c.y, mirror: c.mirror, visible: this.cameraVisible };
    }

    layout() {
      return { cameraOnly: this.options.mode === 'camera', crop: this.options.crop || null, camera: this.cameraLayout() };
    }

    updateLayout() {
      this.worker?.postMessage({ type: 'layout', layout: this.layout() });
    }

    async buildVideo() {
      const o = this.options;
      const cameraOnly = o.mode === 'camera';
      const useCamera = cameraOnly || (o.mode === 'both' && !!this.camera);
      const source = cameraOnly ? this.camera.getVideoTracks()[0] : this.display.getVideoTracks()[0];
      const base = await frameSize(source);
      const crop = !cameraOnly && o.crop;
      // A tab or window can change size while recording; compositing keeps the file's size fixed.
      const resizable = !cameraOnly && this.surface !== 'monitor';
      const composite = cameraOnly ? o.cameraLayout.mirror : useCamera || !!crop || resizable;
      this.width = even(base.width * (crop ? crop.w : 1));
      this.height = even(base.height * (crop ? crop.h : 1));

      if (!composite) {
        source.contentHint = 'detail';
        return source;
      }
      const clone = (track) => new MediaStreamTrackProcessor({ track: track.clone() }).readable;
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });
      const screen = cameraOnly ? null : clone(source);
      const camera = useCamera ? clone(this.camera.getVideoTracks()[0]) : null;
      this.worker = new Worker('compositor-worker.js');
      this.worker.onmessage = ({ data }) => data.type === 'error' && console.warn('Snap5 compositor:', data.message);
      this.worker.postMessage(
        { type: 'start', width: this.width, height: this.height, fps: o.fps, layout: this.layout(), screen, camera, writable: generator.writable },
        [screen, camera, generator.writable].filter(Boolean),
      );
      return generator;
    }

    /* Everything is mixed through one node, so muting the mic never changes the tracks. */
    async buildAudio() {
      const system = this.options.mode === 'camera' ? null : this.display?.getAudioTracks()[0];
      const mic = this.mic?.getAudioTracks()[0];
      if (!system && !mic) return null;
      this.audio = new AudioContext({ sampleRate: 48000 });
      await this.audio.resume();
      const mix = this.audio.createMediaStreamDestination();
      const connect = (track, volume) => {
        const gain = this.audio.createGain();
        gain.gain.value = volume;
        this.audio.createMediaStreamSource(new MediaStream([track])).connect(gain).connect(mix);
        return gain;
      };
      if (system) connect(system, this.options.systemVolume ?? 1);
      if (mic) this.micGain = connect(mic, this.micMuted ? 0 : this.options.micVolume ?? 1);
      return mix.stream.getAudioTracks()[0];
    }

    /* Call after pickScreen() (and after any countdown). */
    async start() {
      const o = this.options;
      const video = await this.buildVideo();
      const audio = await this.buildAudio();
      this.output = new MediaStream(audio ? [video, audio] : [video]);
      const mime = pickMime(o.format, !!audio);
      const bits = Math.round(Math.min(40e6, Math.max(2e6, this.width * this.height * o.fps * (BITS_PER_PIXEL[o.quality] || 0.11))));
      // A keyframe every second makes Chrome flush the file often: little is lost in a crash, and seeking is quick.
      this.recorder = new MediaRecorder(this.output, { mimeType: mime, videoBitsPerSecond: bits, audioBitsPerSecond: 160000, videoKeyFrameIntervalDuration: 1000 });
      this.mime = this.recorder.mimeType || mime;
      this.ext = this.mime.includes('mp4') ? 'mp4' : 'webm';
      this.record = await S.recordings.create({ title: o.title || '', mime: this.mime, ext: this.ext, width: this.width, height: this.height });

      let index = 0;
      this.recorder.ondataavailable = ({ data }) => {
        if (!data.size) return;
        const i = index++;
        this.size += data.size;
        this.writes = this.writes
          .then(() => S.recordings.addChunk(this.record.id, i, data))
          .then(() => S.recordings.update(this.record.id, { size: this.size, duration: this.elapsed }))
          .catch((error) => {
            this.emit('problem', `Saving failed: ${error.message}`);
            this.stop();
          });
      };
      this.recorder.onerror = (event) => {
        this.emit('problem', `Recording error: ${event.error?.message || 'unknown'}`);
        this.stop();
      };
      this.stopped = new Promise((resolve) => (this.recorder.onstop = resolve));
      this.recorder.start(1000);
      this.resumedAt = performance.now();
      this.setState('recording');
    }

    pause() {
      if (this.state !== 'recording') return;
      this.elapsedBefore = this.elapsed;
      this.recorder.pause();
      this.setState('paused');
    }

    resume() {
      if (this.state !== 'paused') return;
      this.recorder.resume();
      this.resumedAt = performance.now();
      this.setState('recording');
    }

    setMicMuted(muted) {
      this.micMuted = muted;
      if (this.micGain) this.micGain.gain.value = muted ? 0 : this.options.micVolume ?? 1;
      this.emit('state', this.state);
    }

    setCameraVisible(visible) {
      this.cameraVisible = visible;
      this.updateLayout();
      this.emit('state', this.state);
    }

    release() {
      this.worker?.postMessage({ type: 'stop' });
      this.worker = null;
      stopTracks(this.display);
      this.output?.getTracks().forEach((t) => t.stop());
      this.audio?.close().catch(() => {});
      this.audio = null;
    }

    async finishRecorder() {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
      await this.stopped;
      await this.writes;
    }

    async stop() {
      if (this.state !== 'recording' && this.state !== 'paused') return null;
      const duration = this.elapsed;
      this.elapsedBefore = duration;
      this.setState('saving');
      try {
        await this.finishRecorder();
        this.release();
        const record = await Recording.finalize(this.record.id, duration);
        this.setState('done');
        this.emit('saved', record);
        return record;
      } catch (error) {
        this.release();
        this.setState('error');
        this.emit('problem', `Could not finish the recording: ${error.message}. It can be recovered when you reopen the recorder.`);
        return null;
      }
    }

    async discard() {
      const id = this.record?.id;
      const active = this.state === 'recording' || this.state === 'paused';
      this.setState('saving');
      if (active) await this.finishRecorder().catch(() => {});
      this.release();
      if (id) await S.recordings.remove(id);
      this.setState('done');
    }

    /* Joins the saved pieces into the final file. Also used to recover interrupted recordings. */
    static async finalize(id, duration) {
      const meta = await S.recordings.get(id);
      let blob = await S.recordings.assemble(id, meta.mime.split(';')[0]);
      // An MP4 that holds only its header (no "moof" fragment) has no picture to play.
      const hasMedia = blob.size && (meta.ext !== 'mp4' || (await containsBox(blob, 'moof')) || (await containsBox(blob, 'mdat')));
      if (!hasMedia) {
        await S.recordings.remove(id);
        throw new Error('it stopped too early, so no video had been written yet');
      }
      const length = duration ?? meta.duration;
      if (meta.ext === 'webm') blob = await S.fixWebmDuration(blob, length);
      const thumb = await S.videoThumb(blob).catch(() => null);
      const record = await S.recordings.update(id, { blob, size: blob.size, duration: length, thumb, done: true });
      await S.recordings.dropChunks(id);
      return record;
    }
  }

  S.Recording = Recording;
  S.pickMime = pickMime;
  S.stopTracks = stopTracks;
})();
