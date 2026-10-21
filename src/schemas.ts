import { z } from "zod";
import { validateFlowSceneCapabilities } from "./flow-capabilities.js";

const frameAssetSchema = z.object({
  asset: z.string().trim().min(1).describe("Exact image title in the open Flow project."),
  id: z.string().uuid().describe("Stable Flow media UUID from the upload or asset receipt; must match the selected tile."),
}).strict();
const frameInputSchema = z.union([z.string(), frameAssetSchema]);

export const sceneSchema = z.object({
  prompt: z.string().min(1).describe("Full English prompt for one clip: action, shot and camera move, location, style, light, sound."),
  type: z.enum(["video", "image"]).default("video"),
  model: z
    .string()
    .optional()
    .describe("Model label as shown in Flow, e.g. 'Omni 1.1 Flash', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Nano Banana Pro'. Images default to the newest Nano Banana (2.1 today); video omitted keeps Flow's current model."),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional().describe("Video supports 16:9 and 9:16 only."),
  duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional().describe("Video length in seconds. Omni models only; Veo 3.1 clips are fixed at 8s."),
  resolution: z.enum(["360p", "720p"]).optional().describe("Video resolution. Omni models only."),
  max_credits: z.number().int().min(0).default(25).describe("Video safety cap: the scene is skipped (nothing spent) if Flow quotes more credits than this. Image generation does not check a credit quote."),
  submit_only: z.boolean().optional().describe("Return when Flow's correlated generation request is dispatched; do not wait for rendering or download results. The default waits for finished media."),
  variants: z.number().int().min(1).max(4).optional().describe("Outputs per prompt (each one spends credits). Default 1."),
  first_frame: frameInputSchema.optional().describe("First frame: absolute image path, 'asset:<title>', or {asset:<exact title>, id:<Flow media UUID>} for an identity-verified project image."),
  last_frame: frameInputSchema.optional().describe("Last frame: absolute image path, 'asset:<title>', or {asset:<exact title>, id:<Flow media UUID>} for an identity-verified project image."),
  video_reference: z.object({
    asset: z.string().trim().min(1).describe("Exact video asset title from flow_assets."),
    start_frame_index: z.number().int().min(0),
    end_frame_index: z.number().int().min(1),
  }).optional().describe("Toby-style video reference edit. Uses the exact source video and configured frame range, through Flow's dedicated video_edit_submit RPC."),
  voice: z.string().trim().min(1).max(120).optional().describe("Exact Flow v2 voice name to select as a composer chip for video generation. Not for images or frame mode; this selects Flow's video voice and is separate from TTS narration."),
  reference_images: z
    .array(z.string())
    .max(3)
    .optional()
    .describe(
      "Reference media: absolute image paths, 'character:<name>' for saved characters, or 'asset:<title>' for project media. Flow's COMPOSER takes references OR first/last frames on a video scene, never both, so with frames set these are skipped and the job says so. Flow itself can do both via agent mode (save the last frame, Animate it, then add the character).",
    ),
  download_quality: z.enum(["original", "upscaled"]).optional().describe("'upscaled' fetches 1080p video / 2K image (free, slower). Default original."),
  retries: z.number().int().min(0).max(3).default(1).describe("Automatic retries when Flow itself reports the generation failed."),
  technique: z.string().optional().describe("Id from flow_techniques (e.g. 'orbit-360'); its exact phrase is appended to the prompt. One per scene."),
  reference_previous: z
    .boolean()
    .optional()
    .describe("Use the previous scene's finished image as an extra reference, so this scene inherits its exact drawing of the characters, style and palette. Best way to keep a set of stills on-model."),
  chain_previous: z
    .boolean()
    .optional()
    .describe("Continue the previous scene in this call: its last frame becomes this scene's first frame. Not valid on the first scene or together with first_frame."),
}).superRefine((scene, context) => {
  try { validateFlowSceneCapabilities(scene); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) }); }
  if (scene.voice && scene.type !== "video") {
    context.addIssue({ code: "custom", path: ["voice"], message: "Flow voice chips are available for video generation only." });
  }
  if (scene.voice && (scene.first_frame || scene.last_frame)) {
    context.addIssue({ code: "custom", path: ["voice"], message: "Flow voice chips are not available in first/last frame mode." });
  }
  if (scene.video_reference && scene.type !== "video") {
    context.addIssue({ code: "custom", path: ["video_reference"], message: "Video-reference editing is only supported for video scenes." });
  }
  if (scene.first_frame && typeof scene.first_frame === "object" && scene.last_frame && typeof scene.last_frame === "object" &&
      scene.first_frame.id.toLowerCase() === scene.last_frame.id.toLowerCase()) {
    context.addIssue({ code: "custom", path: ["last_frame"], message: "First and last frame assets must have distinct media UUIDs." });
  }
});

// Raw shapes double as MCP input schemas and, wrapped in z.object, as HTTP body validators.
export const shapes = {
  status: { detailed: z.boolean().default(true).describe("false skips the plan/credits readout, which briefly opens Flow's account panel.") },
  observer_health: {},
  clear_prompt: {
    expected_prompt: z.string().min(1).max(20_000).describe("Exact text currently shown in Flow's prompt editor. The operation clears only if the active project and prompt still match."),
  },
  generate: {
    project: z.string().min(1).describe("Folder name for the downloaded clips, e.g. 'HotelPromo'."),
    scenes: z.array(sceneSchema).min(1).max(100),
  },
  wait: {
    job_ids: z.array(z.string()).optional().describe("Job ids from a queued call, or the task_id of a call that answered still_working. Default: every queued job."),
    timeout_seconds: z.number().int().min(5).max(900).default(40).describe("An MCP call returns after at most 40 s whatever this says, so call again until finished is true."),
  },
  cancel: { job_id: z.string() },
  retry: { job_ids: z.array(z.string()).optional().describe("Jobs with a confirmed failed or cancelled result. Default: every safe failed job; jobs with an unknown submit outcome are blocked until you inspect Flow to avoid duplicates.") },
  assets: { kind: z.enum(["image", "video", "scene"]).optional() },
  attach_references: {
    references: z.array(z.string().min(1)).min(1).max(3).describe("Named references to attach without generation. Use character:<name> for saved characters; asset:<title> for project media."),
    inspect_only: z.boolean().optional().describe("Open the reference picker, report its exact search/options, and close it without selecting or attaching anything."),
  },
  clear_references: {},
  upload_media: { path: z.string().min(1).describe("Absolute path to an image or video file to upload to the open Flow project. Supports PNG, JPG, WebP, GIF, HEIC, HEIF, AVIF, MP4, MOV, WebM, AVI, MKV or 3GP.") },
  projects: {},
  voice_options: {},
  create_project: {},
  open_project: {
    project_id: z.string().uuid(),
    language: z.enum(["en"]).default("en").describe("Flow automation interface language. English is required."),
  },
  download: {
    project: z.string().min(1).describe("Local folder name under the output root."),
    assets: z.array(z.string().min(1)).min(1).max(30).describe("Titles (or title prefixes) from flow_assets, in the order they should be numbered."),
    quality: z.enum(["original", "upscaled"]).default("original"),
  },
  assemble: {
    project: z.string().min(1).describe("Same project name used in flow_generate."),
    clips: z.array(z.string()).optional().describe("Absolute clip paths in play order. Default: every scene-NN.mp4 in the project folder (first variant of each)."),
    music: z.string().optional().describe("Absolute path to a music file; looped and trimmed to the film length."),
    music_volume: z.number().min(0).max(1).default(0.25),
    clip_volume: z
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe("Volume of the clips' own sound, 0-1. Lower it (around 0.2-0.3) so a narration sits clearly on top; 1 keeps it as recorded."),
    voiceover: z.string().optional().describe("Absolute path to a voiceover audio file, starts at 0:00."),
    output_name: z.string().default("final"),
    hold_last_frame: z.boolean().default(true).describe("Freeze the final frame so a longer voiceover is not cut off."),
  },
  agent: {
    project: z.string().min(1).describe("Folder name for the downloaded images."),
    scenes: z.array(z.string().min(1)).min(1).max(50).describe("One image description per scene, in order."),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("16:9"),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    submit_only: z.boolean().optional().describe("Return after Flow's correlated image request is dispatched; rendering and downloads continue in Flow. Default waits for finished images."),
  },
  edit: {
    project: z.string().min(1).describe("Local folder for the edited clip."),
    asset: z.string().min(1).describe("Title (or title prefix) of a video already in the Flow project; see flow_assets."),
    prompt: z.string().min(1).describe("What to change, e.g. 'change the time of day to golden hour', 'remove the cup', 'make it snow'."),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Flow shows no quote for edits, so max_credits cannot protect you: a 4 s clip cost 20 credits when measured. The real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    submit_only: z.boolean().optional().describe("Return after Flow's correlated video edit request is dispatched; rendering and download are not awaited. Default waits for the finished edit."),
  },
  continue_shot: {
    project: z.string().min(1).describe("Local folder for the new clip."),
    from_asset: z.string().min(1).describe("Title (or title prefix) of the video to continue from; see flow_assets."),
    prompt: z.string().min(1).describe("What happens in the new clip, written as one continuous shot with one camera move."),
    attach: z
      .array(z.string().min(1))
      .max(3)
      .optional()
      .describe("Characters or avatars to keep attached, by name, e.g. ['Me'] for your own Flow avatar or ['Pip']. This is the whole point of this tool: the normal composer cannot hold a character and a start frame at the same time."),
    aspect_ratio: z.enum(["16:9", "9:16"]).default("16:9"),
    mode: z
      .enum(["exact", "likeness"])
      .default("exact")
      .describe(
        "'exact' uses Flow's first-frame animation (I2V): the clip begins on the source clip's real last frame, invisible cut, but attached characters are IGNORED - the likeness has to come from the frame itself. 'likeness' uses reference-to-video (R2V): the character stays locked but the opening frame is only approximate. Flow cannot do both; this is a model limit, not a UI one.",
      ),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Agent mode shows no credit quote before it runs, so max_credits cannot protect you; the real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    force: z
      .boolean()
      .optional()
      .describe("Skip the guard that refuses to run when Flow already holds a fresh-looking continuation of this clip. Only pass it when you have checked the grid and genuinely want another paid take."),
    submit_only: z.boolean().optional().describe("Return after Flow's correlated continuation request is dispatched; rendering and download are not awaited. Default waits for the finished clip."),
  },
  trash: { name: z.string().min(1).describe("Exact title of the item to move to Flow's Trash, as listed by flow_assets.") },
  rename_asset: {
    name: z.string().trim().min(1).max(120).describe("Exact title of the Flow asset, as listed by flow_assets."),
    id: z.string().uuid().optional().describe("Optional Flow media UUID from flow_assets; when provided it must match the exact title."),
    new_name: z.string().trim().min(1).max(120).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "A Flow asset name cannot contain control characters.").describe("New title for this Flow asset."),
  },
  discard: { path: z.string().min(1).describe("A saved film, still, narration or whole project folder inside the films folder, to move to this computer's bin (Mac Trash, Windows Recycle Bin).") },
  outputs: {},
  characters: {},
  character_edit: {
    name: z.string().min(1).describe("Character to change, as listed by flow_characters."),
    rename: z.string().min(1).max(60).optional().describe("Rename the saved character without changing its portrait. The new name is confirmed in Flow's Characters library before returning."),
    change: z
      .string()
      .min(1)
      .max(600)
      .optional()
      .describe(
        "What to change about the look, e.g. 'make his coat red, keep everything else the same'. Leave it out to only save the character's current portrait (after a change made by hand in Flow, or one whose portrait never arrived).",
      ),
    look: z
      .string()
      .min(1)
      .max(1500)
      .optional()
      .describe(
        "The character's whole description AFTER the change, e.g. the old one with 'navy coat' swapped for 'red coat'. Scenes quote it word for word to hold the design, so a stale colour in it fights the new portrait. Without it, the change is added to the end of the old description.",
      ),
  },
  character: {
    name: z.string().min(1).max(60).describe("Character name; scenes then reference it as 'character:<name>' in reference_images."),
    describe: z
      .string()
      .max(1200)
      .optional()
      .describe("What the character looks like. Flow draws the portrait first (free image), then builds the character from it. Use this or `image`."),
    image: z
      .string()
      .min(1)
      .optional()
      .describe("Existing picture instead of `describe`: absolute path, or 'asset:<title>' of an image already in the Flow project."),
    variants: z.number().int().min(1).max(4).default(1).describe("Portrait options to generate when using `describe`; the first option is used to save the character."),
    aspect_ratio: z.enum(["3:4", "1:1", "9:16", "16:9", "4:3"]).optional().describe("Frame for the drawn portrait when using `describe`. Default 3:4."),
    personality: z.string().max(500).optional().describe("How the character acts; Flow uses it when crafting scenes."),
    voice: z.string().optional().describe("Flow voice name, e.g. 'Charon' (male, informative) or 'Aoede' (female, breezy)."),
  },
  techniques: { category: z.enum(["camera", "product", "transition", "image"]).optional() },
};

export type Args<K extends keyof typeof shapes> = z.infer<z.ZodObject<(typeof shapes)[K]>>;
