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

  // DL-04: a lower-priority variant must beat the current best NCC by more
  // than this epsilon to displace it, so variant choice is deterministic and
  // biased toward the higher-priority variant on near-ties.
  const VARIANT_PRIORITY_EPSILON = 0.02;
  const MAX_DECODED_VARIANT_MASKS = 8;
  // Decoded alpha masks for raw (base64) variant specs, shared across Remover
  // instances in this page session so a per-response instance does not
  // re-decode the same PNG. Values may be null (decode failed / no alpha).
  const decodedVariantMaskCache = new Map();

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

  function rawAlpha01(mask, x, y) {
    const value = Number(mask.data[y * mask.width + x]) || 0;
    return value > 1 ? value / 255 : value;
  }

  // Bilinear resample of a mask's alpha channel to target dimensions — the
  // same smoothing a renderer applies when it scales the rendered logo, so
  // the rescaled template tracks the rendered watermark at other sizes.
  function rescaleMask(mask, targetW, targetH) {
    const data = new Uint8Array(targetW * targetH);
    const stepX = mask.width / targetW;
    const stepY = mask.height / targetH;
    for (let y = 0; y < targetH; y++) {
      for (let x = 0; x < targetW; x++) {
        const gx = (x + 0.5) * stepX - 0.5;
        const gy = (y + 0.5) * stepY - 0.5;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = gx - x0;
        const fy = gy - y0;
        let sum = 0;
        for (let dy = 0; dy <= 1; dy++) {
          for (let dx = 0; dx <= 1; dx++) {
            const px = clamp(x0 + dx, 0, mask.width - 1);
            const py = clamp(y0 + dy, 0, mask.height - 1);
            sum += rawAlpha01(mask, px, py) * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
          }
        }
        data[y * targetW + x] = Math.round(sum * 255);
      }
    }
    return { width: targetW, height: targetH, data };
  }

  // One logo variant. Accepted forms: a decoded mask ({mask} or the entry
  // itself as a mask) and/or a raw alpha_png_b64 spec decoded lazily by
  // _ensureVariantMasks. baseShortSide is the short side of the reference
  // render the mask was captured at; baseWidth/baseHeight collapse to it.
  // Entries with neither a usable mask nor a base64 spec are dropped.
  function asVariant(entry, index) {
    if (!entry || typeof entry !== "object") return null;
    const decoded = asMask(entry.mask) || asMask(entry);
    const b64 = typeof entry.alpha_png_b64 === "string" && entry.alpha_png_b64.trim() ? entry.alpha_png_b64
      : (typeof entry.alphaPngB64 === "string" && entry.alphaPngB64.trim() ? entry.alphaPngB64 : null);
    if (!decoded && !b64) return null;
    let baseShortSide = Number(entry.baseShortSide ?? entry.base_short_side);
    if (!Number.isFinite(baseShortSide) || baseShortSide <= 0) {
      const baseWidth = Number(entry.baseWidth ?? entry.base_width);
      const baseHeight = Number(entry.baseHeight ?? entry.base_height);
      baseShortSide = baseWidth > 0 && baseHeight > 0 ? Math.min(baseWidth, baseHeight) : null;
    }
    const priority = Number(entry.priority);
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim()
      : (typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `variant-${index}`);
    return {
      key: `variant-${index}`,
      id,
      mask: decoded,
      maskB64: decoded ? null : b64,
      baseShortSide: baseShortSide > 0 ? baseShortSide : null,
      priority: Number.isFinite(priority) ? priority : 0,
      index,
    };
  }

  function normalizeVariants(list) {
    if (!Array.isArray(list)) return [];
    const variants = [];
    list.forEach((entry, index) => {
      const variant = asVariant(entry, index);
      if (variant) variants.push(variant);
    });
    return variants;
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
        edgeSmoothing: true,
        edgeSmoothWidth: 3,
        nccSampleStep: 2,
        searchCornersFirst: true,
        ...options,
      };
      this.mask = asMask(options.mask);
      this.variants = normalizeVariants(options.variants);
      this._scaledMaskCache = new Map();
    }

    configure(options = {}) {
      if (options.mask !== undefined) this.mask = asMask(options.mask);
      if (options.variants !== undefined) {
        this.variants = normalizeVariants(options.variants);
        this._scaledMaskCache.clear();
      }
      this.options = { ...this.options, ...options };
      return this;
    }

    // Raw base64 variant specs decode lazily (PNG decoding is async); the
    // decoded masks are cached module-wide by their base64 source. A variant
    // that fails to decode stays mask-less and is simply never evaluated —
    // it cannot poison the other variants or the legacy mask.
    async _ensureVariantMasks() {
      for (const variant of this.variants) {
        if (variant.mask || !variant.maskB64) continue;
        if (decodedVariantMaskCache.has(variant.maskB64)) {
          variant.mask = asMask(decodedVariantMaskCache.get(variant.maskB64));
          continue;
        }
        let decoded = null;
        try { decoded = asMask(await maskFromAlphaPng(variant.maskB64)); } catch (_) { decoded = null; }
        if (decodedVariantMaskCache.size >= MAX_DECODED_VARIANT_MASKS) {
          decodedVariantMaskCache.delete(decodedVariantMaskCache.keys().next().value);
        }
        decodedVariantMaskCache.set(variant.maskB64, decoded);
        variant.mask = decoded;
      }
    }

    // Evaluation order: explicit variants by priority (higher first, config
    // order breaks ties), then the legacy configured mask as a native-scale
    // fallback variant — DL-01's lone alpha_png_b64 is a single-variant list
    // whose behavior is unchanged when no variants are configured.
    _evaluationVariants() {
      const decoded = this.variants.filter(variant => variant.mask);
      decoded.sort((a, b) => (b.priority - a.priority) || (a.index - b.index));
      if (this.mask && !decoded.some(variant => variant.mask === this.mask)) {
        decoded.push({
          key: "legacy",
          id: null,
          mask: this.mask,
          baseShortSide: null,
          priority: Number.NEGATIVE_INFINITY,
          index: Number.MAX_SAFE_INTEGER,
        });
      }
      return decoded;
    }

    // The variant's mask rescaled for this image: ratio of the image's short
    // side to the variant's base short side. Variants without a base short
    // side (including the legacy mask) stay at native scale.
    _scaledVariantMask(variant, image) {
      const mask = variant.mask;
      let scale = 1;
      if (variant.baseShortSide > 0) {
        scale = clamp(Math.min(image.width, image.height) / variant.baseShortSide, 0.05, 16);
      }
      if (Math.abs(scale - 1) < 0.01) return { mask, scale: 1 };
      const targetW = Math.max(1, Math.round(mask.width * scale));
      const targetH = Math.max(1, Math.round(mask.height * scale));
      if (targetW < 4 || targetH < 4) return null;
      const cacheKey = `${variant.key}:${targetW}x${targetH}`;
      let scaled = this._scaledMaskCache.get(cacheKey);
      if (!scaled) {
        scaled = rescaleMask(mask, targetW, targetH);
        this._scaledMaskCache.set(cacheKey, scaled);
      }
      return { mask: scaled, scale };
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

    // Patch-based gain estimate (the original estimator): hill-climb the
    // gain that minimizes _roughness. Its known weakness (DL-11): the
    // roughness criterion compares each restored pixel against neighbors in
    // the still-watermarked image, so on dense alpha patterns — where most
    // neighbors carry the watermark too — it settles far below the true
    // gain and the removal fails verification.
    _estimateGainFromPatch(image, mask, x, y) {
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

    // Surround-based gain estimate: for each watermarked pixel, estimate
    // the underlying background from nearby pixels the watermark does not
    // touch (expanding ring search, first ring with enough clean samples),
    // then invert the blend model observed = bg + alpha*gain*(255 - bg)
    // per pixel and take the median — independent of the watermarked
    // neighbors that bias the patch estimate. Returns null when too few
    // pixels have a usable surround (caller falls back to the patch gain).
    _estimateGainFromSurround(image, mask, x, y) {
      const gains = [];
      const maxRing = 6;
      for (let my = 0; my < mask.height; my++) {
        for (let mx = 0; mx < mask.width; mx++) {
          const alpha = alphaAt(mask, mx, my);
          if (alpha < 0.15) continue;
          const ix = Math.round(x + mx);
          const iy = Math.round(y + my);
          if (ix < 1 || iy < 1 || ix >= image.width - 1 || iy >= image.height - 1) continue;
          let background = null;
          for (let ring = 1; ring <= maxRing && background === null; ring++) {
            let sum = 0;
            let count = 0;
            for (let dy = -ring; dy <= ring; dy++) {
              for (let dx = -ring; dx <= ring; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
                const nx = ix + dx;
                const ny = iy + dy;
                if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) continue;
                if (alphaAt(mask, Math.round(nx - x), Math.round(ny - y)) >= 0.05) continue;
                sum += pixelLuma(image, nx, ny);
                count++;
              }
            }
            if (count >= 3) background = sum / count;
          }
          if (background === null || background >= 250) continue;
          const denominator = alpha * (255 - background);
          if (denominator <= 1) continue;
          const gain = (pixelLuma(image, ix, iy) - background) / denominator;
          if (Number.isFinite(gain)) gains.push(gain);
        }
      }
      if (gains.length < 8) return null;
      gains.sort((a, b) => a - b);
      return clamp(gains[Math.floor(gains.length / 2)], 0.35, 1.65);
    }

    // Post-apply roughness of one gain candidate: the candidate is applied
    // to a patch-local copy (mask bbox plus a 1px margin — never a
    // full-image rescan) and scored against its OWN cleaned neighbors,
    // which is the surface a viewer actually sees. Luma restore is exact
    // here because every channel shares the same alpha.
    _postApplyRoughness(image, mask, x, y, gain) {
      const ox = Math.round(x);
      const oy = Math.round(y);
      const rx = Math.max(0, ox - 1);
      const ry = Math.max(0, oy - 1);
      const rw = Math.min(image.width, ox + mask.width + 1) - rx;
      const rh = Math.min(image.height, oy + mask.height + 1) - ry;
      if (rw <= 0 || rh <= 0) return Number.POSITIVE_INFINITY;
      const region = new Float64Array(rw * rh);
      for (let j = 0; j < rh; j++) {
        for (let i = 0; i < rw; i++) region[j * rw + i] = pixelLuma(image, rx + i, ry + j);
      }
      for (let my = 0; my < mask.height; my++) {
        for (let mx = 0; mx < mask.width; mx++) {
          const alpha = clamp(alphaAt(mask, mx, my) * gain, 0, 0.98);
          if (alpha < 0.01) continue;
          const ix = ox + mx;
          const iy = oy + my;
          if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) continue;
          const index = (iy - ry) * rw + (ix - rx);
          region[index] = clamp((region[index] - 255 * alpha) / Math.max(0.02, 1 - alpha), 0, 255);
        }
      }
      let score = 0;
      let count = 0;
      for (let my = 0; my < mask.height; my++) {
        for (let mx = 0; mx < mask.width; mx++) {
          if (alphaAt(mask, mx, my) < 0.05) continue;
          const i = ox + mx - rx;
          const j = oy + my - ry;
          if (i <= 0 || j <= 0 || i >= rw - 1 || j >= rh - 1) continue;
          const index = j * rw + i;
          const neighbor = (region[index - 1] + region[index + 1] + region[index - rw] + region[index + rw]) / 4;
          score += Math.abs(region[index] - neighbor);
          count++;
        }
      }
      return count ? score / count : Number.POSITIVE_INFINITY;
    }

    // Dual gain estimate (DL-11): both estimators run on the located patch
    // and the winner is the candidate whose APPLIED result is smoother.
    // Ties (and a missing surround estimate) keep the patch gain, so the
    // choice is deterministic and the legacy behavior survives wherever
    // the surround offers no improvement. Estimation and scoring snap to
    // the integer origin the removal actually applies on — the apply loop
    // maps mask pixels by Math.round(x + mx) === Math.round(x) + mx, so a
    // fractional (refined) position has exactly one applied grid, and
    // estimating on any other grid misaligns the per-pixel alpha the
    // surround estimator and the scorer rely on.
    _estimateGain(image, mask, x, y) {
      const gx = Math.round(x);
      const gy = Math.round(y);
      const patchGain = this._estimateGainFromPatch(image, mask, gx, gy);
      const surroundGain = this._estimateGainFromSurround(image, mask, gx, gy);
      if (surroundGain === null || Math.abs(surroundGain - patchGain) < 1e-9) return patchGain;
      const patchScore = this._postApplyRoughness(image, mask, gx, gy, patchGain);
      const surroundScore = this._postApplyRoughness(image, mask, gx, gy, surroundGain);
      return surroundScore < patchScore ? surroundGain : patchGain;
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

    // The scan half of location: the best NCC position for one (already
    // rescaled) mask, corners first then a full scan — thresholding, gain
    // estimation and refinement are the caller's job.
    _scanBest(image, mask) {
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
      return best;
    }

    _locateWithMask(image, mask, variant = null, scale = 1) {
      const best = this._scanBest(image, mask);
      if (!best || best.ncc < Number(this.options.nccThreshold)) return null;
      best.gain = this._estimateGain(image, mask, best.x, best.y);
      const refined = this._refineByRoughness(image, mask, best);
      // The gain the removal will use is re-estimated at the refined
      // position: the coarse scan position can sit a pixel off the true
      // placement, and a gain estimated there scores/applies on the wrong
      // pixels (DL-11).
      return { ...refined, variant, scale, mask, gain: this._estimateGain(image, mask, refined.x, refined.y) };
    }

    locate(image, mask) {
      if (!image?.width || !image?.height) return null;
      // An explicitly passed mask keeps the original single-mask contract:
      // native scale, no variant reporting.
      if (mask !== undefined) {
        const explicit = asMask(mask);
        if (!explicit) return null;
        return this._locateWithMask(image, explicit, null, 1);
      }
      // Detection mode: every configured variant is located with its mask
      // rescaled to the image; the best score wins, with the priority
      // epsilon keeping near-ties on the higher-priority variant.
      const candidates = this._evaluationVariants();
      if (!candidates.length) return null;
      let winner = null;
      for (const candidate of candidates) {
        const scaled = this._scaledVariantMask(candidate, image);
        if (!scaled) continue;
        const best = this._scanBest(image, scaled.mask);
        if (!best) continue;
        if (!winner || best.ncc > winner.ncc + VARIANT_PRIORITY_EPSILON) {
          winner = { ...best, variant: candidate.id, scale: scaled.scale, mask: scaled.mask };
        }
      }
      if (!winner || winner.ncc < Number(this.options.nccThreshold)) return null;
      const point = { x: winner.x, y: winner.y, ncc: winner.ncc };
      point.gain = this._estimateGain(image, winner.mask, point.x, point.y);
      const refined = this._refineByRoughness(image, winner.mask, point);
      // Re-estimate at the refined position, as in _locateWithMask.
      return { ...refined, variant: winner.variant, scale: winner.scale, mask: winner.mask, gain: this._estimateGain(image, winner.mask, refined.x, refined.y) };
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

    // Edge smoothing (DL-11): blend the patch's border band toward the
    // local neighbor mean of the cleaned image, strongest at the very edge
    // (weight 1/2) and fading to zero at edgeSmoothWidth pixels in — this
    // closes the gradient step the reverse-alpha pass leaves where the
    // patch meets untouched surround (the halo ring). Reads come from a
    // snapshot of the patch region (bbox plus a 1px margin), so the pass
    // has no directional bias; pixels at distance >= edgeSmoothWidth from
    // the border (the interior) and everything outside the patch are never
    // written.
    _smoothPatchEdges(image, mask, point) {
      if (this.options.edgeSmoothing === false) return;
      const width = Math.max(1, Math.round(Number(this.options.edgeSmoothWidth) || 3));
      const ox = Math.round(point.x);
      const oy = Math.round(point.y);
      const rx = Math.max(0, ox - 1);
      const ry = Math.max(0, oy - 1);
      const rw = Math.min(image.width, ox + mask.width + 1) - rx;
      const rh = Math.min(image.height, oy + mask.height + 1) - ry;
      if (rw <= 0 || rh <= 0) return;
      const snapshot = new Uint8ClampedArray(rw * rh * 4);
      for (let j = 0; j < rh; j++) {
        for (let i = 0; i < rw; i++) {
          const source = ((ry + j) * image.width + (rx + i)) * 4;
          const target = (j * rw + i) * 4;
          for (let channel = 0; channel < 4; channel++) snapshot[target + channel] = image.data[source + channel];
        }
      }
      const snapAt = (ix, iy, channel) => {
        const i = clamp(ix, rx, rx + rw - 1) - rx;
        const j = clamp(iy, ry, ry + rh - 1) - ry;
        return snapshot[(j * rw + i) * 4 + channel];
      };
      for (let my = 0; my < mask.height; my++) {
        for (let mx = 0; mx < mask.width; mx++) {
          const distance = Math.min(mx, my, mask.width - 1 - mx, mask.height - 1 - my);
          if (distance >= width) continue;
          if (alphaAt(mask, mx, my) < 0.01) continue;
          const ix = ox + mx;
          const iy = oy + my;
          if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) continue;
          const weight = 0.5 * (1 - distance / width);
          const offset = (iy * image.width + ix) * 4;
          for (let channel = 0; channel < 3; channel++) {
            const neighbor = (snapAt(ix - 1, iy, channel) + snapAt(ix + 1, iy, channel) + snapAt(ix, iy - 1, channel) + snapAt(ix, iy + 1, channel)) / 4;
            image.data[offset + channel] = (1 - weight) * image.data[offset + channel] + weight * neighbor;
          }
        }
      }
    }

    remove(imageData, mask) {
      const image = typeof ImageData !== "undefined" && imageData instanceof ImageData ? imageData : null;
      if (!image || image.width * image.height > this.options.maxPixels) return { changed: false, reason: "unavailable" };
      // An explicit mask keeps the single-mask contract; without one,
      // detection runs across the configured variants and the winning
      // variant's rescaled mask drives the removal and the verification.
      let point = null;
      let variant = null;
      let scale = 1;
      if (mask !== undefined) {
        mask = asMask(mask);
        if (!mask) return { changed: false, reason: "unavailable" };
        point = this._locateWithMask(image, mask, null, 1);
      } else {
        point = this.locate(image);
        if (point) {
          mask = point.mask;
          variant = point.variant;
          scale = point.scale;
        }
      }
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
      this._smoothPatchEdges(cleaned, mask, point);
      const nccAfter = this._nccAt(cleaned, mask, point.x, point.y);
      if (nccAfter > Number(this.options.minNccAfter)) return { changed: false, reason: "verification_failed", nccBefore: point.ncc, nccAfter, image: original, variant, scale };
      return { changed: true, image: cleaned, x: point.x, y: point.y, gain: point.gain, nccBefore: point.ncc, nccAfter, variant, scale };
    }

    async processBlob(blob, options = {}) {
      if (!(blob instanceof Blob) || !/^image\//i.test(blob.type || "")) return { blob, changed: false, reason: "not_an_image" };
      if (!this.mask && !this.variants.length) return { blob, changed: false, reason: "mask_not_configured" };
      await this._ensureVariantMasks();
      if (!this.mask && !this.variants.some(variant => variant.mask)) return { blob, changed: false, reason: "mask_not_configured" };
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const result = this.remove(context.getImageData(0, 0, canvas.width, canvas.height), options.mask);
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
