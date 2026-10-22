/*
 * Optional Flow watermark removal pipeline.
 *
 * The remover is intentionally pure: it accepts ImageData plus an alpha mask
 * and returns a new ImageData or a rollback result. Network interception and
 * download triggering live in media-interceptor.js. A mask must be supplied by
 * the extension configuration; without one the original media is returned.
 */
(() => {
  "use strict";

  const root = globalThis;
  if (root.WatermarkRemover?.version >= 1) return;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  function asMask(mask) {
    if (!mask || !Number.isInteger(mask.width) || !Number.isInteger(mask.height) || mask.width <= 0 || mask.height <= 0) return null;
    const source = mask.data || mask.alpha || mask;
    if (!source || typeof source.length !== "number" || source.length < mask.width * mask.height) return null;
    return { width: mask.width, height: mask.height, data: source };
  }

  function alphaAt(mask, x, y) {
    if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return 0;
    const value = Number(mask.data[y * mask.width + x]) || 0;
    return clamp(value > 1 ? value / 255 : value, 0, 0.98);
  }

  async function maskFromAlphaPng(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const raw = value.trim();
    const dataUrl = raw.startsWith("data:") ? raw : `data:image/png;base64,${raw}`;
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const alpha = new Uint8Array(canvas.width * canvas.height);
    for (let index = 0; index < alpha.length; index++) alpha[index] = pixels[index * 4 + 3];
    return { width: canvas.width, height: canvas.height, data: alpha };
  }

  function pixelLuma(image, x, y) {
    const offset = (y * image.width + x) * 4;
    return luma(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
  }

  class Remover {
    constructor(options = {}) {
      this.version = 1;
      this.options = {
        nccThreshold: 0.68,
        minNccAfter: 0.25,
        maxPixels: 14_000_000,
        scanStep: 3,
        refineStep: 0.25,
        darkBackgroundThreshold: 72,
        darkDenoise: true,
        nccSampleStep: 2,
        searchCornersFirst: true,
        ...options,
      };
      this.mask = asMask(options.mask);
    }

    configure(options = {}) {
      if (options.mask !== undefined) this.mask = asMask(options.mask);
      this.options = { ...this.options, ...options };
      return this;
    }

    _nccAt(image, mask, x, y) {
      const values = [];
      const template = [];
      const sampleStep = Math.max(1, Number(this.options.nccSampleStep) || 2);
      for (let my = 0; my < mask.height; my += sampleStep) {
        for (let mx = 0; mx < mask.width; mx += sampleStep) {
          const alpha = alphaAt(mask, mx, my);
          if (alpha < 0.05) continue;
          const ix = Math.round(x + mx);
          const iy = Math.round(y + my);
          if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) return -1;
          values.push(pixelLuma(image, ix, iy));
          template.push(alpha);
        }
      }
      if (values.length < 8) return -1;
      const meanA = values.reduce((sum, value) => sum + value, 0) / values.length;
      const meanB = template.reduce((sum, value) => sum + value, 0) / template.length;
      let numerator = 0;
      let varianceA = 0;
      let varianceB = 0;
      for (let index = 0; index < values.length; index++) {
        const da = values[index] - meanA;
        const db = template[index] - meanB;
        numerator += da * db;
        varianceA += da * da;
        varianceB += db * db;
      }
      return varianceA && varianceB ? numerator / Math.sqrt(varianceA * varianceB) : -1;
    }

    _roughness(image, mask, x, y, gain = 1) {
      let score = 0;
      let count = 0;
      for (let my = 0; my < mask.height; my++) {
        for (let mx = 0; mx < mask.width; mx++) {
          const alpha = alphaAt(mask, mx, my);
          if (alpha < 0.05) continue;
          const px = Math.round(x + mx);
          const py = Math.round(y + my);
          if (px <= 0 || py <= 0 || px >= image.width - 1 || py >= image.height - 1) continue;
          const base = pixelLuma(image, px, py);
          const effectiveAlpha = clamp(alpha * gain, 0, 0.98);
          const restored = (base - 255 * effectiveAlpha) / Math.max(0.02, 1 - effectiveAlpha);
          const neighbor = (pixelLuma(image, px - 1, py) + pixelLuma(image, px + 1, py) + pixelLuma(image, px, py - 1) + pixelLuma(image, px, py + 1)) / 4;
          score += Math.abs(restored - neighbor);
          count++;
        }
      }
      return count ? score / count : Number.POSITIVE_INFINITY;
    }

    _estimateGain(image, mask, x, y) {
      let bestGain = 1;
      let bestScore = Number.POSITIVE_INFINITY;
      for (let pass = 0; pass < 3; pass++) {
        const center = pass === 0 ? 1 : bestGain;
        const radius = pass === 0 ? 0.45 : 0.12 / (pass + 1);
        const step = radius / 4;
        for (let gain = center - radius; gain <= center + radius + 1e-6; gain += step) {
          const candidate = clamp(gain, 0.35, 1.65);
          const score = this._roughness(image, mask, x, y, candidate);
          if (score < bestScore) { bestScore = score; bestGain = candidate; }
        }
      }
      return bestGain;
    }

    _refineByRoughness(image, mask, point) {
      let best = { ...point };
      let bestScore = this._roughness(image, mask, best.x, best.y, point.gain);
      const step = Number(this.options.refineStep) || 0.25;
      for (let dx = -1; dx <= 1.0001; dx += step) {
        for (let dy = -1; dy <= 1.0001; dy += step) {
          const score = this._roughness(image, mask, point.x + dx, point.y + dy, point.gain);
          if (score < bestScore) { best = { ...point, x: point.x + dx, y: point.y + dy }; bestScore = score; }
        }
      }
      return best;
    }

    locate(image, mask = this.mask) {
      mask = asMask(mask);
      if (!mask || !image?.width || !image?.height) return null;
      let best = null;
      const step = Math.max(1, Number(this.options.scanStep) || 3);
      const maxX = Math.max(0, image.width - mask.width);
      const maxY = Math.max(0, image.height - mask.height);
      const scan = (fromX, toX, fromY, toY, scanStep) => {
        for (let y = fromY; y <= toY; y += scanStep) {
          for (let x = fromX; x <= toX; x += scanStep) {
            const score = this._nccAt(image, mask, x, y);
            if (!best || score > best.ncc) best = { x, y, ncc: score };
          }
        }
      };
      if (this.options.searchCornersFirst) {
        const cornerW = Math.max(mask.width, Math.floor(image.width * 0.45));
        const cornerH = Math.max(mask.height, Math.floor(image.height * 0.45));
        scan(Math.max(0, maxX - cornerW), maxX, Math.max(0, maxY - cornerH), maxY, Math.max(step, 5));
        if (!best || best.ncc < Number(this.options.nccThreshold)) {
          scan(0, maxX, 0, maxY, Math.max(step, 9));
        }
      } else scan(0, maxX, 0, maxY, step);
      if (!best || best.ncc < Number(this.options.nccThreshold)) return null;
      best.gain = this._estimateGain(image, mask, best.x, best.y);
      return this._refineByRoughness(image, mask, best);
    }

    _applyDarkDenoise(image, original, mask, point) {
      if (!this.options.darkDenoise) return;
      const threshold = Number(this.options.darkBackgroundThreshold) || 72;
      for (let my = 1; my < mask.height - 1; my++) {
        for (let mx = 1; mx < mask.width - 1; mx++) {
          const alpha = alphaAt(mask, mx, my);
          if (alpha < 0.05) continue;
          const x = Math.round(point.x + mx);
          const y = Math.round(point.y + my);
          if (x <= 0 || y <= 0 || x >= image.width - 1 || y >= image.height - 1) continue;
          const background = pixelLuma(original, x - 1, y) + pixelLuma(original, x + 1, y) + pixelLuma(original, x, y - 1) + pixelLuma(original, x, y + 1);
          if (background / 4 > threshold) continue;
          const center = (y * image.width + x) * 4;
          for (let channel = 0; channel < 3; channel++) {
            const neighbors = [image.data[center - 4 + channel], image.data[center + 4 + channel], image.data[center - image.width * 4 + channel], image.data[center + image.width * 4 + channel]];
            image.data[center + channel] = neighbors.reduce((sum, value) => sum + value, image.data[center + channel]) / 5;
          }
        }
      }
    }

    remove(imageData, mask = this.mask) {
      const image = typeof ImageData !== "undefined" && imageData instanceof ImageData ? imageData : null;
      mask = asMask(mask);
      if (!image || !mask || image.width * image.height > this.options.maxPixels) return { changed: false, reason: "unavailable" };
      const point = this.locate(image, mask);
      if (!point) return { changed: false, reason: "watermark_not_found" };
      const original = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
      const cleaned = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
      for (let my = 0; my < mask.height; my++) {
        for (let mx = 0; mx < mask.width; mx++) {
          const alpha = clamp(alphaAt(mask, mx, my) * point.gain, 0, 0.98);
          if (alpha < 0.01) continue;
          const x = Math.round(point.x + mx);
          const y = Math.round(point.y + my);
          if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
          const offset = (y * image.width + x) * 4;
          for (let channel = 0; channel < 3; channel++) cleaned.data[offset + channel] = clamp((cleaned.data[offset + channel] - 255 * alpha) / Math.max(0.02, 1 - alpha), 0, 255);
        }
      }
      this._applyDarkDenoise(cleaned, original, mask, point);
      const nccAfter = this._nccAt(cleaned, mask, point.x, point.y);
      if (nccAfter > Number(this.options.minNccAfter)) return { changed: false, reason: "verification_failed", nccBefore: point.ncc, nccAfter, image: original };
      return { changed: true, image: cleaned, x: point.x, y: point.y, gain: point.gain, nccBefore: point.ncc, nccAfter };
    }

    async processBlob(blob, options = {}) {
      if (!(blob instanceof Blob) || !/^image\//i.test(blob.type || "")) return { blob, changed: false, reason: "not_an_image" };
      if (!this.mask) return { blob, changed: false, reason: "mask_not_configured" };
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const result = this.remove(context.getImageData(0, 0, canvas.width, canvas.height), options.mask || this.mask);
      bitmap.close?.();
      if (!result.changed) return { blob, ...result };
      context.putImageData(result.image, 0, 0);
      const output = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Watermark cleanup could not encode the image.")), blob.type || "image/png", 0.98));
      return { blob: output, ...result };
    }
  }

  root.WatermarkRemover = Remover;
  root.WatermarkRemover.maskFromAlphaPng = maskFromAlphaPng;
})();
