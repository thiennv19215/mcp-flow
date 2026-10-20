/**
 * Flow 3D Camera Angles Engine
 * Ported and enhanced from TobyFlow 3D Orbit Angle Architecture.
 *
 * Provides spherical coordinate mapping (Rotation, Tilt, Zoom) to cinematographic
 * and photographic prompt modifiers for subject-consistent Flow re-angling.
 */

export interface AnglePreset {
  id: string;
  name: string;
  slug: string;
  description: string;
  base_prompt: string;
  default_aspect?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
}

export const ROTATION_KEYWORDS: Record<number, string> = {
  "-180": "directly behind the subject, showing the back",
  "-135": "behind and to the left of the subject, three-quarter back view",
  "-90": "to the left of the subject, left profile view",
  "-45": "slightly to the left of the subject, three-quarter front view from the left",
  "0": "directly in front of the subject, frontal view facing the camera",
  "45": "slightly to the right of the subject, three-quarter front view from the right",
  "90": "to the right of the subject, right profile view",
  "135": "behind and to the right of the subject, three-quarter back view",
  "180": "directly behind the subject, showing the back",
};

export const TILT_KEYWORDS: Record<number, string> = {
  "-60": "very low near the ground looking up at the subject, worm's eye perspective",
  "-30": "low angle looking up at the subject",
  "0": "at eye level with the subject",
  "30": "high angle looking down at the subject",
  "60": "very high angle looking steeply down at the subject, bird's eye view",
  "90": "directly above the subject, strictly top-down overhead perspective",
};

export const ZOOM_KEYWORDS: Record<number, string> = {
  "-2": "far away, extreme wide shot showing the full surrounding environment",
  "-1": "wide shot, full body visible in frame",
  "0": "medium shot, waist up",
  "1": "close-up shot focused on face and shoulders",
  "2": "extreme close-up macro detail",
};

export const ANGLE_PRESETS: Record<string, AnglePreset> = {
  "portrait-reangle": {
    id: "portrait-reangle",
    name: "Portrait Re-angle",
    slug: "portrait-reangle",
    description: "Re-angle a character or person while locking face, hair, clothing and lighting.",
    base_prompt:
      "Recreate this exact subject from the reference image, camera positioned {angle_modifier}, {tilt_modifier}, {zoom_modifier}. Maintain identical appearance, facial structure, clothing, colors, and all details. Same lighting and background style.",
    default_aspect: "9:16",
  },
  "product-reangle": {
    id: "product-reangle",
    name: "Product 360 Spin",
    slug: "product-reangle",
    description: "Re-angle commercial product on clean studio background.",
    base_prompt:
      "Studio product photography of the exact item from the reference image, camera positioned {angle_modifier}, {tilt_modifier}, {zoom_modifier}. Keep product geometry, materials, branding, labels and colors 100% identical. Premium commercial lighting with soft clean reflections.",
    default_aspect: "1:1",
  },
  "cinematic-orbit": {
    id: "cinematic-orbit",
    name: "Cinematic Dynamic Angle",
    slug: "cinematic-orbit",
    description: "Cinematic film still with shallow depth of field and dramatic lighting.",
    base_prompt:
      "Cinematic movie still featuring the exact subject from the reference image, shot with camera placed {angle_modifier}, {tilt_modifier}, {zoom_modifier}. 85mm lens, shallow depth of field, cinematic atmospheric lighting, photorealistic textures.",
    default_aspect: "16:9",
  },
  "character-turnaround": {
    id: "character-turnaround",
    name: "Character Model Sheet",
    slug: "character-turnaround",
    description: "Character turnaround perspective for animation or 3D modeling.",
    base_prompt:
      "Clean character turnaround model sheet view of the exact character, camera view {angle_modifier}, {tilt_modifier}, {zoom_modifier}. Crisp clean contours, neutral even studio lighting, precise proportions matching the reference image perfectly.",
    default_aspect: "9:16",
  },
};

/**
 * Finds the nearest numeric key in a dictionary to a given value.
 */
export function findNearestKey(value: number, dict: Record<number | string, string>): string {
  const keys = Object.keys(dict).map(Number).sort((a, b) => a - b);
  if (!keys.length) return "";
  let closest = keys[0];
  let minDiff = Math.abs(value - closest);
  for (const k of keys) {
    const diff = Math.abs(value - k);
    if (diff < minDiff) {
      minDiff = diff;
      closest = k;
    }
  }
  return dict[closest] || "";
}

export interface BuildAnglePromptOptions {
  preset?: string;
  rotation?: number; // -180 to 180
  tilt?: number;     // -60 to 90
  zoom?: number;     // -2 to 2
  customPrompt?: string;
  extraPrompt?: string;
}

export interface BuildAnglePromptResult {
  prompt: string;
  preset: AnglePreset;
  rotation: number;
  tilt: number;
  zoom: number;
  modifiers: {
    angle_modifier: string;
    tilt_modifier: string;
    zoom_modifier: string;
  };
}

/**
 * Compiles 3D spherical coordinates into a natural language Flow prompt.
 */
export function buildAnglePrompt(opts: BuildAnglePromptOptions): BuildAnglePromptResult {
  const rotation = Math.max(-180, Math.min(180, opts.rotation ?? 0));
  const tilt = Math.max(-60, Math.min(90, opts.tilt ?? 0));
  const zoom = Math.max(-2, Math.min(2, opts.zoom ?? 0));

  const presetKey = opts.preset && ANGLE_PRESETS[opts.preset] ? opts.preset : "portrait-reangle";
  const preset = ANGLE_PRESETS[presetKey];

  const angle_modifier = findNearestKey(rotation, ROTATION_KEYWORDS);
  const tilt_modifier = findNearestKey(tilt, TILT_KEYWORDS);
  const zoom_modifier = findNearestKey(zoom, ZOOM_KEYWORDS);

  let template = opts.customPrompt?.trim() || preset.base_prompt;

  let prompt = template
    .replace(/\{angle_modifier\}/g, angle_modifier)
    .replace(/\{tilt_modifier\}/g, tilt_modifier)
    .replace(/\{zoom_modifier\}/g, zoom_modifier);

  if (opts.extraPrompt?.trim()) {
    prompt = `${prompt} ${opts.extraPrompt.trim()}`;
  }

  return {
    prompt,
    preset,
    rotation,
    tilt,
    zoom,
    modifiers: {
      angle_modifier,
      tilt_modifier,
      zoom_modifier,
    },
  };
}

export function listAnglePresets(): AnglePreset[] {
  return Object.values(ANGLE_PRESETS);
}
