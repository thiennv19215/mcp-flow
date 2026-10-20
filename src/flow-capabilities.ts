import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type MediaType = "image" | "video";
type CapabilityRegistry = {
  version: number;
  defaults: {
    maxReferences: number;
    videoAspectRatios: string[];
    imageAspectRatios: string[];
    frameInputs: number;
    framesAndReferencesMutuallyExclusive: boolean;
  };
  models: Array<{
    match: string[];
    types: MediaType[];
    fixedDuration?: number;
    durations: number[];
    resolutions: string[];
    aspectRatios: string[];
    maxReferences: number;
    supportsFrames: boolean;
    framesAndReferencesMutuallyExclusive: boolean;
  }>;
};

const registryPath = fileURLToPath(new URL("../flow-model-capabilities.json", import.meta.url));
const registry = JSON.parse(readFileSync(registryPath, "utf8")) as CapabilityRegistry;

function normalize(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, " ").trim();
}

export function flowModelCapability(model?: string) {
  const wanted = normalize(model);
  if (!wanted) return undefined;
  return registry.models.find(rule => rule.match.some(alias => wanted.includes(normalize(alias))));
}

export function validateFlowSceneCapabilities(scene: {
  type: MediaType;
  model?: string;
  aspect_ratio?: string;
  duration?: number;
  resolution?: string;
  first_frame?: string;
  last_frame?: string;
  reference_images?: string[];
}, index?: number): void {
  const prefix = index === undefined ? "" : `Scene ${index + 1}: `;
  const reject = (message: string): never => {
    throw Object.assign(new Error(`${prefix}${message}`), {
      code: "FLOW_MODEL_UNSUPPORTED",
      category: "unsupported",
      retryable: false,
      outcome_unknown: false,
    });
  };

  const frames = [scene.first_frame, scene.last_frame].filter(Boolean).length;
  const references = scene.reference_images?.length ?? 0;
  const allowedAspectRatios = scene.type === "video" ? registry.defaults.videoAspectRatios : registry.defaults.imageAspectRatios;
  if (scene.aspect_ratio && !allowedAspectRatios.includes(scene.aspect_ratio)) {
    reject(`${scene.type} aspect ratio ${scene.aspect_ratio} is not supported. Allowed: ${allowedAspectRatios.join(", ")}.`);
  }
  const rule = flowModelCapability(scene.model);
  const maxReferences = rule?.maxReferences ?? registry.defaults.maxReferences;
  if (references > maxReferences) reject(`Flow accepts at most ${maxReferences} references for ${scene.model ? `model "${scene.model}"` : "this generation"}.`);
  if (frames > registry.defaults.frameInputs) reject(`Flow accepts at most ${registry.defaults.frameInputs} frame inputs.`);
  if (scene.type === "image" && frames) reject("First and last frame inputs are only supported for video generation.");
  if (scene.type === "image" && (scene.duration !== undefined || scene.resolution !== undefined)) {
    reject("Duration and video resolution settings are only supported for video generation.");
  }
  if (frames && rule && !rule.supportsFrames) reject(`Model "${scene.model}" does not support first/last frame inputs.`);
  if (!rule) return; // Unknown/new Flow models remain UI-authoritative until added to this registry.
  if (!rule.types.includes(scene.type)) reject(`Model "${scene.model}" does not support ${scene.type} generation.`);
  if (scene.aspect_ratio && !rule.aspectRatios.includes(scene.aspect_ratio)) {
    reject(`Model "${scene.model}" does not support ${scene.aspect_ratio}; allowed: ${rule.aspectRatios.join(", ")}.`);
  }
  if (scene.duration !== undefined && !rule.durations.includes(scene.duration)) {
    const expected = rule.fixedDuration ? `fixed at ${rule.fixedDuration} seconds` : `supports ${rule.durations.join(", ")} seconds`;
    reject(`Model "${scene.model}" ${expected}.`);
  }
  if (scene.resolution !== undefined && !rule.resolutions.includes(scene.resolution)) {
    reject(`Model "${scene.model}" does not offer ${scene.resolution} resolution${rule.resolutions.length ? `; allowed: ${rule.resolutions.join(", ")}` : ""}.`);
  }
}

export const flowCapabilityDefaults = registry.defaults;
