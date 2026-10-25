import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { FFMPEG_HINT } from "./platform.js";

const exec = promisify(execFile);
// Windows does not execute .cmd/.bat files through execFile unless shell mode
// is enabled. This also lets the test and user-provided wrappers behave like
// native ffprobe/ffmpeg binaries without changing the normal executable path.
const run = (file: string, args: string[], options: Record<string, unknown> = {}) => exec(
  file,
  args,
  {
    ...options,
    ...(process.platform === "win32" && /\.(?:cmd|bat)$/i.test(file) ? { shell: true } : {}),
  } as Parameters<typeof execFile>[2],
);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MCP_FFPROBE ?? "ffprobe";

export interface AssembleOptions {
  dir: string;
  clips?: string[];
  music?: string;
  music_volume: number;
  clip_volume?: number;
  voiceover?: string;
  output_name: string;
  hold_last_frame?: boolean;
}

interface ClipInfo {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
}

async function probe(file: string): Promise<ClipInfo> {
  // A raw ffprobe dump ("moov atom not found") told the user nothing. Say which file and what to do about it.
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file]).catch(() => {
    throw new Error(`"${basename(file)}" isn't a playable video - it may be an unfinished download or a ZIP of several clips. Remove it, or pick other clips.`);
  });
  const data = JSON.parse(String(stdout)) as { streams: { codec_type: string; width?: number; height?: number }[]; format?: { duration?: string } };
  const video = data.streams.find((s) => s.codec_type === "video");
  if (!video?.width || !video.height) throw new Error(`${file} has no video stream.`);
  // ffprobe reports no duration (or "N/A") for some files; a NaN here would
  // leak into the ffmpeg atrim/tpad filter arguments and fail there with an
  // unreadable filter error instead of naming the bad clip.
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`"${basename(file)}" has no readable duration — ffprobe could not measure it. The file may be corrupt or an unfinished download; remove it, or pick other clips.`);
  }
  return {
    width: video.width,
    height: video.height,
    duration,
    hasAudio: data.streams.some((s) => s.codec_type === "audio"),
  };
}

// Clips are normally scene-NN.mp4, but a film can also be cut from clips pulled out of Flow (clip-NN) or restyled
// ones (edit-NN). Narration takes and previously assembled films are never treated as footage.
function defaultClips(dir: string): string[] {
  if (!existsSync(dir)) {
    throw new Error(`There's no "${basename(dir)}" folder in your films yet. Add clips with "Upload a video" or "From my films", or type the name of a folder that already has clips in it.`);
  }
  const files = readdirSync(dir).filter((f) => /\.mp4$/i.test(f) && !/^narration-/i.test(f));
  const numbered = new Map<string, string>();
  for (const f of files.sort()) {
    const key = f.match(/^((?:scene|clip|edit)-\d+)(-v\d+)?\.mp4$/i)?.[1];
    if (key && !numbered.has(key)) numbered.set(key, join(dir, f));
  }
  if (numbered.size) return [...numbered.values()];
  // Nothing follows the naming scheme: fall back to every other mp4, oldest first, so a hand-named clip still works.
  return files
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t)
    .map((x) => join(dir, x.f));
}

// Joins the scene clips into one film, keeping their own sound and laying music / voiceover on top.
export async function assemble(o: AssembleOptions): Promise<{ output: string; clips: string[]; duration: number; held_last_frame: number }> {
  // Clips can now come from anywhere, so the project folder the film is saved into may not exist yet.
  if (o.clips?.length) mkdirSync(o.dir, { recursive: true });
  const out = join(o.dir, o.output_name.replace(/[^\w.-]+/g, "_").replace(/(\.mp4)?$/, ".mp4"));
  const clips = (o.clips?.length ? o.clips : defaultClips(o.dir)).filter((c) => c !== out);
  if (!clips.length) throw new Error(`No clips found in ${o.dir}. Generate or download a clip first, or pass clips explicitly.`);
  for (const f of [...clips, o.music, o.voiceover]) if (f && !existsSync(f)) throw new Error(`File not found: ${f}`);

  let infos = await Promise.all(clips.map(probe));
  // A narration longer than the footage would be cut off, so the last frame is held until the voice finishes.
  let hold = 0;
  if (o.hold_last_frame !== false && o.voiceover) {
    const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", o.voiceover]);
    hold = Math.max(0, Number(String(stdout).trim()) + 0.6 - infos.reduce((sum, i) => sum + i.duration, 0));
  }
  // Size the film to the biggest clip so a 720p opener cannot pull a 1080p clip down with it.
  const { width, height } = infos.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  const args: string[] = ["-y"];
  for (const clip of clips) args.push("-i", clip);
  const filters: string[] = [];
  // The clips' own sound used to play at full volume no matter what, drowning a narration laid on top. Music already
  // had its own level; the clips now do too.
  const clipVolume = Math.min(1, Math.max(0, o.clip_volume ?? 1));
  infos.forEach((info, i) => {
    const freeze = hold > 0.05 && i === infos.length - 1 ? `,tpad=stop_mode=clone:stop_duration=${hold.toFixed(2)}` : "";
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24${freeze}[v${i}]`,
    );
    filters.push(
      info.hasAudio
        ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${clipVolume}${hold > 0.05 && i === infos.length - 1 ? `,apad=pad_dur=${hold.toFixed(2)}` : ""}[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${(info.duration + (i === infos.length - 1 ? hold : 0)).toFixed(2)}[a${i}]`,
    );
  });
  filters.push(`${infos.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${clips.length}:v=1:a=1[v][clipaudio]`);

  const mix = ["[clipaudio]"];
  let input = clips.length;
  if (o.music) {
    args.push("-stream_loop", "-1", "-i", o.music);
    filters.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${o.music_volume}[music]`);
    mix.push("[music]");
    input++;
  }
  if (o.voiceover) {
    args.push("-i", o.voiceover);
    filters.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo[vo]`);
    mix.push("[vo]");
  }
  filters.push(mix.length > 1 ? `${mix.join("")}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0[a]` : "[clipaudio]anull[a]");

  const output = out;
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    output,
  );
  try {
    await run(FFMPEG, args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(e.code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT}).` : `ffmpeg failed: ${(e.stderr ?? String(e)).slice(-600)}`);
  }
  return { output, clips, duration: infos.reduce((sum, i) => sum + i.duration, 0) + hold, held_last_frame: Number(hold.toFixed(2)) };
}
