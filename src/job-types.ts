import type { FlowErrorCategory } from "./flow-error-policy.js";
import type { SafeFlowOperationDiagnostics, SafeUnknownSubmitDiagnostics } from "./flow-request-diagnostics.js";

export type JobStatus = "queued" | "running" | "waiting_for_user" | "submitted" | "done" | "failed" | "cancelled";
export type FrameAssetInput = string | { asset: string; id: string };

export interface SceneParams {
  prompt: string;
  type: "video" | "image";
  max_credits: number;
  submit_only?: boolean;
  duration?: 4 | 6 | 8 | 10;
  resolution?: "360p" | "720p";
  model?: string;
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  variants?: number;
  first_frame?: FrameAssetInput;
  last_frame?: FrameAssetInput;
  voice?: string;
  reference_images?: string[];
  video_reference?: { asset: string; start_frame_index: number; end_frame_index: number };
  chain_from?: string;
  reference_from?: string;
  edit_asset?: string;
  agent_scenes?: string[];
  agent_numbers?: number[];
  continue_from?: string;
  attach?: string[];
  continue_mode?: "exact" | "likeness";
  retries?: number;
  download_quality?: "original" | "upscaled";
  output_dir: string;
  file_stem: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  params: SceneParams;
  files: string[];
  attempts: number;
  credits?: number;
  progress?: string;
  note?: string;
  error?: string;
  errorCategory?: FlowErrorCategory;
  retryAfterAt?: string;
  outcomeUnknown?: boolean;
  requestDispatched?: boolean;
  serverAcceptanceObserved?: boolean;
  creditQuoteVerified?: boolean;
  requestDiagnostics?: SafeUnknownSubmitDiagnostics;
  operationDiagnostics?: SafeFlowOperationDiagnostics;
  persistNow?: () => void;
  failed_scenes?: number[];
  createdAt: string;
  finishedAt?: string;
}

