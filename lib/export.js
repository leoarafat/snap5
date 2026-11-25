/* Image encoding, clipboard and PDF helpers shared by the overlay and extension pages. */
(() => {
  const S = (globalThis.Snap5 ||= {});

  const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

  const toBlob = (canvas, format = 'png', quality = 0.92) =>
    new Promise((resolve, reject) => {
      let source = canvas;
      if (format === 'jpg') {
        // JPEG has no alpha: flatten onto white.
        source = document.createElement('canvas');
        source.width = canvas.width;
        source.height = canvas.height;
        const ctx = source.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, source.width, source.height);
        ctx.drawImage(canvas, 0, 0);
      }
      source.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the image (too large)'))), TYPES[format], quality);
    });

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });

  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load the image'));
      img.src = src;
    });

  /* Decodes a data: URL without fetch(), which strict page CSPs can block. */
  const dataUrlToBlob = (dataUrl) => {
    const comma = dataUrl.indexOf(',');
    const type = dataUrl.slice(5, dataUrl.indexOf(';'));
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  };

  /* Accepts a Blob or a Promise<Blob>; passing the promise keeps the user activation alive. */
  const copyImage = async (blobOrPromise) => {
    if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error('The clipboard is not available on this page');
    window.focus();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobOrPromise })]);
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
  };

  /* Minimal PDF writer: one JPEG per page. Long captures are split into A4-ratio pages. */
  const toPdf = async (canvas, { split = false } = {}) => {
    const pageSlice = split ? Math.round(canvas.width * Math.SQRT2) : canvas.height;
    const pages = [];
    for (let y = 0; y < canvas.height; y += pageSlice) {
      const h = Math.min(pageSlice, canvas.height - y);
      const part = document.createElement('canvas');
      part.width = canvas.width;
      part.height = split ? pageSlice : h;
      const ctx = part.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, part.width, part.height);
      ctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
      const jpeg = new Uint8Array(await (await toBlob(part, 'jpg', 0.92)).arrayBuffer());
      pages.push({ jpeg, w: part.width, h: part.height });
    }

    const encoder = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = (data) => {
      const bytes = typeof data === 'string' ? encoder.encode(data) : data;
      chunks.push(bytes);
      length += bytes.length;
    };
    const object = (n, body, stream) => {
      offsets[n] = length;
      push(`${n} 0 obj\n${body}\n`);
      if (stream) {
        push('stream\n');
        push(stream);
        push('\nendstream\n');
      }
      push('endobj\n');
    };

    push('%PDF-1.4\n');
    const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
    pages.forEach((p, i) => {
      const n = 3 + i * 3;
      // 595pt = A4 width; PDF caps page height at 14400pt.
      const k = Math.min(595 / p.w, 14400 / p.h);
      const w = (p.w * k).toFixed(2);
      const h = (p.h * k).toFixed(2);
      const content = encoder.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
      object(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
      object(n + 1, `<< /Length ${content.length} >>`, content);
      object(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`, p.jpeg);
    });
    const xref = length;
    const total = 3 + pages.length * 3;
    push(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let n = 1; n < total; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(chunks, { type: 'application/pdf' });
  };

  const shutter = () => {
    try {
      const audio = new AudioContext();
      const length = Math.floor(audio.sampleRate * 0.07);
      const buffer = audio.createBuffer(1, length, audio.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 4);
      const source = audio.createBufferSource();
      const gain = audio.createGain();
      gain.gain.value = 0.25;
      source.buffer = buffer;
      source.connect(gain).connect(audio.destination);
      source.start();
      source.onended = () => audio.close();
    } catch {}
  };

  S.exporter = { toBlob, toPdf, blobToDataUrl, dataUrlToBlob, loadImage, copyImage, copyText, shutter };
})();
