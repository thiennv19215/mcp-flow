/* Pure Flow workflow planners shared by the extension queue and its callers.
 * These functions construct queue jobs only; they do not read storage, touch
 * the Flow tab, or submit work.
 */

export class FlowWorkflowPlanError extends Error {
  constructor(message, code = "FLOW_INVALID_ARGUMENT", category = "invalid_argument") {
    super(message);
    this.name = "FlowWorkflowPlanError";
    this.code = code;
    this.category = category;
    this.retryable = false;
    this.outcome_unknown = false;
  }
}

const unsupported = (message, code = "FLOW_MODEL_UNSUPPORTED") =>
  new FlowWorkflowPlanError(message, code, "unsupported");

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new FlowWorkflowPlanError(`${label} is required.`);
  return value.trim();
}

function jobList(queue) {
  if (Array.isArray(queue)) return queue;
  if (Array.isArray(queue?.jobs)) return queue.jobs;
  if (Array.isArray(queue?.items)) return queue.items;
  return [];
}

function jobParams(job) {
  return job?.params || job?.payload?.params || job?.payload || job?.data?.payload?.params || job?.data?.payload || {};
}

function assetName(asset) {
  return String(asset?.name || asset?.title || asset?.file_stem || asset?.path || "");
}

function scopedAssets(assets, project) {
  if (!Array.isArray(assets)) return [];
  return assets.filter(asset => !asset?.project || !project || asset.project === project || asset.output_dir === project);
}

function maxNumber(values, prefix) {
  const re = new RegExp(`(?:^|[/\\\\])${prefix}-(\\d+)(?:\\D|$)`, "i");
  return Math.max(0, ...values.map(value => Number(String(value ?? "").match(re)?.[1] || 0)));
}

function nextStem(prefix, project, queue, knownAssets, outputAssets = knownAssets) {
  const queued = jobList(queue).filter(job => {
    const p = jobParams(job);
    return (!p.output_dir || p.output_dir === project) && String(p.file_stem || p.workflow?.fileStem || "").toLowerCase().startsWith(`${prefix}-`);
  }).map(job => jobParams(job).file_stem || jobParams(job).workflow?.fileStem);
  const disk = scopedAssets(outputAssets, project).map(assetName);
  const next = Math.max(maxNumber(queued, prefix), maxNumber(disk, prefix)) + 1;
  return `${prefix}-${String(next).padStart(2, "0")}`;
}

function sceneOffset(project, queue, knownAssets, outputAssets = knownAssets) {
  const queued = jobList(queue).filter(job => {
    const p = jobParams(job);
    return (!p.output_dir || p.output_dir === project) && String(p.file_stem || p.workflow?.fileStem || "").toLowerCase().startsWith("scene-");
  }).map(job => jobParams(job).file_stem || jobParams(job).workflow?.fileStem);
  const disk = scopedAssets(outputAssets, project).map(assetName);
  return Math.max(maxNumber(queued, "scene"), maxNumber(disk, "scene"));
}

function resolveTechnique(technique, techniques, sceneNumber) {
  if (!technique) return "";
  const found = Array.isArray(techniques)
    ? techniques.find(item => item?.id === technique)
    : techniques instanceof Map ? techniques.get(technique) : techniques?.[technique];
  if (!found) throw new FlowWorkflowPlanError(`Scene ${sceneNumber}: Unknown technique "${technique}".`, "FLOW_TECHNIQUE_UNKNOWN");
  const phrase = typeof found === "string" ? found : found.phrase;
  if (typeof phrase !== "string" || !phrase.trim()) throw new FlowWorkflowPlanError(`Scene ${sceneNumber}: technique "${technique}" has no prompt phrase.`, "FLOW_TECHNIQUE_INVALID");
  return phrase.trim();
}

function characterName(reference) {
  if (typeof reference !== "string") return "";
  if (/^character:/i.test(reference)) return reference.slice(10).trim();
  if (reference.startsWith("asset:")) return reference.slice(6).trim();
  return "";
}

function characterDescription(name, characterLooks) {
  if (characterLooks instanceof Map) return characterLooks.get(name) || characterLooks.get(name.toLowerCase()) || "";
  return characterLooks?.[name] || characterLooks?.[name.toLowerCase()] || "";
}

function knownAssetMatches(title, knownAssets, project) {
  const wanted = title.trim().toLocaleLowerCase();
  return scopedAssets(knownAssets, project).filter(asset => {
    const names = [asset?.name, asset?.title].filter(value => typeof value === "string").map(value => value.trim().toLocaleLowerCase());
    return names.includes(wanted);
  });
}

function frameInput(value, label) {
  if (typeof value === "string") {
    const assetName = value.replace(/^asset:/i, "").trim();
    if (!assetName || /^[a-z]:[\\/]/i.test(value) || value.startsWith("/")) {
      throw unsupported(`${label} must be an exact Flow asset title; local file paths need to be staged by the extension first.`, "FLOW_FRAME_INPUT_UNAVAILABLE");
    }
    return { assetName };
  }
  if (value && typeof value === "object" && typeof value.asset === "string" && value.asset.trim()) {
    return { assetName: value.asset.trim(), ...(value.id ? { expectedId: value.id } : {}) };
  }
  throw new FlowWorkflowPlanError(`${label} must be an asset title or an asset/id pair.`);
}

function flowAttachments(references, knownAssets, project) {
  return (references || []).map(reference => {
    if (typeof reference !== "string" || !reference.trim()) throw new FlowWorkflowPlanError("Reference images must be non-empty strings.");
    const value = reference.trim();
    if (/^character:/i.test(value)) return { assetName: value };
    if (/^asset:/i.test(value)) {
      const title = value.slice(6).trim();
      if (!title) throw new FlowWorkflowPlanError("Asset references must include an exact title.");
      const matches = knownAssetMatches(title, knownAssets, project);
      if (matches.length > 1) throw unsupported(`More than one known Flow asset exactly matches "${title}"; no generation was queued.`, "FLOW_ASSET_AMBIGUOUS");
      if (matches.length === 1) {
        const asset = matches[0];
        if (asset.kind && asset.kind !== "image") {
          throw unsupported(`Known Flow asset "${title}" is ${asset.kind}, not an image reference; no generation was queued.`, "FLOW_ASSET_KIND_MISMATCH");
        }
        const expectedId = asset.id || asset.mediaId || asset.media_id;
        if (expectedId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(expectedId))) {
          throw unsupported(`Known Flow asset "${title}" has an invalid media ID; no generation was queued.`, "FLOW_ASSET_ID_INVALID");
        }
        return { assetName: title, ...(expectedId ? { expectedId: String(expectedId) } : {}) };
      }
      if (Array.isArray(knownAssets) && knownAssets.length > 0) {
        throw unsupported(`The known Flow assets do not contain an exact image titled "${title}"; no generation was queued.`, "FLOW_ASSET_NOT_FOUND");
      }
      return { assetName: title };
    }
    if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value)) {
      throw unsupported("Local reference image paths must be staged by the extension before generation.", "FLOW_REFERENCE_UPLOAD_UNAVAILABLE");
    }
    throw new FlowWorkflowPlanError(`Reference "${value}" must use character:<name> or asset:<exact title>.`);
  });
}

function lockPrompt(references, characterLooks) {
  const cast = (references || []).flatMap(reference => {
    const name = characterName(reference);
    if (!name) return [];
    if (/^asset:/i.test(reference) && !characterDescription(name, characterLooks)) return [];
    return [name];
  });
  if (!cast.length) return "";
  return ` CHARACTER LOCK — ${cast.join(" and ")} must match the reference image exactly, as if copying it: same head shape and size, same face, same eyes, same hair, same skin, same build and proportions, same clothing items in the same colours, same hands, and the same rendering style and level of realism as the reference. Never redesign, restyle, re-proportion, re-age or re-colour them, and never swap an item for a similar one.${cast.map(name => {
    const description = characterDescription(name, characterLooks);
    return description ? ` ${name} is exactly: ${description}.` : "";
  }).join("")}`;
}

function validateCapabilities(scene, index, capabilityRegistry) {
  const prefix = `Scene ${index + 1}: `;
  const reject = message => { throw unsupported(prefix + message); };
  const type = scene.type || "video";
  if (type !== "image" && type !== "video") reject(`Unknown media type "${type}".`);
  const frames = [scene.first_frame, scene.last_frame].filter(Boolean).length;
  const references = scene.reference_images?.length || 0;
  const defaults = capabilityRegistry?.defaults || {
    maxReferences: 3, videoAspectRatios: ["16:9", "9:16"],
    imageAspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"], frameInputs: 2,
  };
  if (scene.video_reference) {
    if (type !== "video") reject("Video-reference editing is only supported for video scenes.");
    if (frames || references) reject("Toby-style video-reference editing accepts one video asset and frame range only; remove first/last frames and image references.");
    if (!scene.video_reference.asset?.trim()) reject("Video-reference editing needs an exact video asset title.");
    const { start_frame_index: start, end_frame_index: end } = scene.video_reference;
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end <= start) reject("Video-reference frame range must use integer indices with end_frame_index greater than start_frame_index.");
  }
  if (scene.voice && type !== "video") reject("Flow voice chips are available for video generation only.");
  if (scene.voice && frames) reject("Flow voice chips are not available in first/last frame mode.");
  const allowedRatios = type === "video" ? defaults.videoAspectRatios : defaults.imageAspectRatios;
  if (scene.aspect_ratio && !allowedRatios.includes(scene.aspect_ratio)) reject(`${type} aspect ratio ${scene.aspect_ratio} is not supported. Allowed: ${allowedRatios.join(", ")}.`);
  const model = String(scene.model || "").normalize("NFKC").toLowerCase();
  const rule = capabilityRegistry?.models?.find(item => (item.match || []).some(alias => model.includes(String(alias).normalize("NFKC").toLowerCase())));
  const maxRefs = rule?.maxReferences ?? defaults.maxReferences;
  if (references > maxRefs) reject(`Flow accepts at most ${maxRefs} references for ${scene.model ? `model "${scene.model}"` : "this generation"}.`);
  if (frames > (defaults.frameInputs ?? 2)) reject(`Flow accepts at most ${defaults.frameInputs ?? 2} frame inputs.`);
  if (type === "image" && frames) reject("First and last frame inputs are only supported for video generation.");
  if (type === "image" && (scene.duration !== undefined || scene.resolution !== undefined)) reject("Duration and video resolution settings are only supported for video generation.");
  if (frames && rule && !rule.supportsFrames) reject(`Model "${scene.model}" does not support first/last frame inputs.`);
  if (!rule) return;
  if (!rule.types.includes(type)) reject(`Model "${scene.model}" does not support ${type} generation.`);
  if (scene.aspect_ratio && !rule.aspectRatios.includes(scene.aspect_ratio)) reject(`Model "${scene.model}" does not support ${scene.aspect_ratio}; allowed: ${rule.aspectRatios.join(", ")}.`);
  if (scene.duration !== undefined && !rule.durations.includes(scene.duration)) reject(`Model "${scene.model}" ${rule.fixedDuration ? `fixed at ${rule.fixedDuration} seconds` : `supports ${rule.durations.join(", ")} seconds`}.`);
  if (scene.resolution !== undefined && !rule.resolutions.includes(scene.resolution)) reject(`Model "${scene.model}" does not offer ${scene.resolution} resolution${rule.resolutions.length ? `; allowed: ${rule.resolutions.join(", ")}` : ""}.`);
}

/** Build generation jobs while preserving the per-call scene order and dependencies. */
export function planFlowBatch({ project, output_dir = project, scenes }, { queue = [], knownAssets = [], outputAssets = knownAssets, characterLooks = {}, techniques = [], capabilityRegistry } = {}) {
  nonempty(project, "project");
  if (!Array.isArray(scenes) || scenes.length < 1 || scenes.length > 100) throw new FlowWorkflowPlanError("scenes must contain between 1 and 100 scenes.");
  const invalidChain = scenes.findIndex((scene, i) => scene.chain_previous && (i === 0 || scene.first_frame || (scene.type || "video") === "image"));
  if (invalidChain >= 0) throw new FlowWorkflowPlanError(`Scene ${invalidChain + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.`);
  if (scenes[0]?.reference_previous) throw new FlowWorkflowPlanError("Scene 1 has no previous scene to reference.");
  scenes.forEach((scene, i) => {
    nonempty(scene?.prompt, `Scene ${i + 1} prompt`);
    if (scene?.video_reference) {
      validateCapabilities(scene, i, capabilityRegistry);
      throw unsupported(`Scene ${i + 1}: Toby-style video-reference editing requires Flow's dynamic video_edit_submit RPC configuration, which is not available in the native extension yet. Nothing was submitted.`, "FLOW_VIDEO_REFERENCE_CONFIG_UNAVAILABLE");
    }
    validateCapabilities(scene, i, capabilityRegistry);
    resolveTechnique(scene.technique, techniques, i + 1);
  });
  const offset = sceneOffset(output_dir, queue, knownAssets, outputAssets);
  const jobs = scenes.map((source, index) => {
    const {
      chain_previous, reference_previous, technique, reference_images, first_frame, last_frame,
      aspect_ratio, max_credits, submit_only, model, duration, resolution, ...scene
    } = source;
    const sceneNumber = offset + index + 1;
    const phrase = resolveTechnique(technique, techniques, index + 1);
    const prompt = `${scene.prompt.trim().replace(/\.?$/, ".")}${phrase ? ` ${phrase}` : ""}${lockPrompt(reference_images, characterLooks)}${reference_previous ? " Match the previous image exactly for the subject's appearance, colour palette, lighting and rendering style; this is the same scene a moment later." : ""}`;
    const dependency = chain_previous
      ? { type: "chain_previous", sequence: index - 1, requiredKind: "video_last_frame", resolution: "extension_runner" }
      : reference_previous ? { type: "reference_previous", sequence: index - 1, requiredKind: "image", resolution: "extension_runner" } : undefined;
    const workflow = { project, sceneNumber, sequence: index, ...(dependency ? { dependency } : {}) };
    const attachments = flowAttachments(reference_images, knownAssets, project);
    const aspectRatio = aspect_ratio;
    const maxCredits = max_credits;
    const submitOnly = submit_only;
    const videoSettings = (scene.type || "video") === "video" && (model !== undefined || aspectRatio !== undefined || duration !== undefined || resolution !== undefined)
      ? { ...(model !== undefined ? { model } : {}), ...(aspectRatio !== undefined ? { aspectRatio } : {}), ...(duration !== undefined ? { duration } : {}), ...(resolution !== undefined ? { resolution } : {}) }
      : undefined;
    return {
      operation: "flow.generation.submit",
      label: `Scene ${sceneNumber}: ${scene.prompt.trim().slice(0, 120)}`,
      payload: {
        ...scene,
        type: scene.type || "video",
        prompt,
        ...(first_frame ? { firstFrame: frameInput(first_frame, `Scene ${index + 1} first_frame`) } : {}),
        ...(last_frame ? { lastFrame: frameInput(last_frame, `Scene ${index + 1} last_frame`) } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        ...(maxCredits !== undefined ? { maxCredits } : {}),
        ...(submitOnly !== undefined ? { submitOnly } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(videoSettings ? { video_settings: videoSettings } : {}),
        output_dir, file_stem: `scene-${String(sceneNumber).padStart(2, "0")}`, workflow,
      },
    };
  });
  return { jobs, nextSceneNumber: offset + scenes.length + 1, output_dir };
}

/** Construct a video edit queue job. */
export function planFlowEdit({ project, output_dir = project, asset, prompt, download_quality, submit_only }, { queue = [], knownAssets = [], outputAssets = knownAssets } = {}) {
  nonempty(project, "project"); nonempty(asset, "asset"); nonempty(prompt, "prompt");
  const fileStem = nextStem("edit", output_dir, queue, knownAssets, outputAssets);
  return { output_dir, job: {
    operation: "flow.edit.run", label: `Edit ${asset}: ${prompt.slice(0, 100)}`,
    payload: { params: { prompt, type: "video", max_credits: 0, edit_asset: asset, download_quality, submit_only, retries: submit_only ? 0 : undefined, output_dir, file_stem: fileStem }, workflow: { project, fileStem, type: "video" } },
  } };
}

/** Construct a continuation job; callers pass the latest Flow assets for the duplicate-spend guard. */
export function planFlowContinue({ project, output_dir = project, from_asset, prompt, attach, aspect_ratio = "16:9", mode = "exact", download_quality, force = false, submit_only }, { queue = [], knownAssets = [], outputAssets = knownAssets } = {}) {
  nonempty(project, "project"); nonempty(from_asset, "from_asset"); nonempty(prompt, "prompt");
  if (!force) {
    const source = from_asset.toLowerCase();
    const recent = scopedAssets(knownAssets, project).filter(asset => asset.kind === "video").slice(0, 6);
    const words = value => value.split(/[^a-z0-9]+/i).filter(word => word.length > 3).map(word => word.toLowerCase());
    const echo = recent.find(asset => {
      const name = assetName(asset).toLowerCase();
      return name !== source && !name.startsWith(source) && words(name).some(word => words(source).includes(word));
    });
    if (echo) throw new FlowWorkflowPlanError(`Flow already holds a recent clip called "${assetName(echo)}", which looks like a continuation of "${from_asset}" that may have just been generated and charged for. Check it with flow_assets / flow_download before spending again. Pass force: true if you really do want another take.`, "FLOW_CONTINUE_POSSIBLE_DUPLICATE");
  }
  const fileStem = nextStem("shot", output_dir, queue, knownAssets, outputAssets);
  return { output_dir, job: {
    operation: "flow.continue.run", label: `Continue ${from_asset}: ${prompt.slice(0, 100)}`,
    payload: { params: { prompt, type: "video", max_credits: 0, retries: submit_only ? 0 : undefined, continue_from: from_asset, attach, continue_mode: mode, submit_only, aspect_ratio, download_quality, output_dir, file_stem: fileStem }, workflow: { project, fileStem, type: "video" } },
  } };
}

/** Construct an Agent image batch job. */
export function planFlowAgentBatch({ project, output_dir = project, scenes, aspect_ratio = "16:9", download_quality, submit_only }, { queue = [], knownAssets = [], outputAssets = knownAssets } = {}) {
  nonempty(project, "project");
  if (!Array.isArray(scenes) || scenes.length < 1 || scenes.length > 50 || scenes.some(scene => typeof scene !== "string" || !scene.trim())) throw new FlowWorkflowPlanError("scenes must contain between 1 and 50 non-empty scene descriptions.");
  const fileStem = nextStem("scene", output_dir, queue, knownAssets, outputAssets);
  return { output_dir, job: {
    operation: "flow.agent.batch", label: `Agent batch: ${scenes.length} images`,
    payload: { params: { prompt: `Agent batch: ${scenes.length} images`, type: "image", max_credits: 0, retries: submit_only ? 0 : undefined, aspect_ratio, download_quality, submit_only, agent_scenes: scenes, output_dir, file_stem: fileStem }, workflow: { project, fileStem, type: "image" } },
  } };
}
