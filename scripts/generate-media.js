import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const mediaDir = path.join(rootDir, "public", "media");
const scratchDir = path.join(rootDir, ".generated-audio");

const segmentDuration = 6;
const toneLeadInSeconds = 0.08;

const clips = [
  { name: "content-1", phrase: "This is chunk 1.", toneHz: 440 },
  { name: "content-2", phrase: "This is chunk 2.", toneHz: 494 },
  { name: "content-3", phrase: "This is chunk 3.", toneHz: 523 },
  { name: "content-4", phrase: "This is chunk 4.", toneHz: 587 },
  { name: "content-5", phrase: "This is chunk 5.", toneHz: 659 },
  { name: "content-6", phrase: "This is chunk 6.", toneHz: 698 },
  { name: "broadcast-ad", phrase: "This is a broadcast ad.", toneHz: 784 },
  { name: "interstitial", phrase: "This is an interstitial.", toneHz: 880 }
];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function audioDuration(filePath) {
  const duration = Number(output("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    filePath
  ]));

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Speech synthesis produced no audio for ${filePath}`);
  }

  return duration;
}

function makeClip({ name, phrase, toneHz }) {
  const voicePath = path.join(scratchDir, `${name}.aiff`);
  const outputPath = path.join(mediaDir, `${name}.ts`);

  run("say", ["-o", voicePath, phrase]);
  const voiceDuration = Math.min(audioDuration(voicePath) + toneLeadInSeconds, segmentDuration - 0.25);
  const toneDelayMs = Math.round(voiceDuration * 1000);
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    voicePath,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${toneHz}:sample_rate=48000:duration=${segmentDuration}`,
    "-filter_complex",
    `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=1.0,atrim=0:${voiceDuration},apad,atrim=0:${segmentDuration},asetpts=N/SR/TB[voice];` +
      `[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.08,adelay=${toneDelayMs}:all=1,atrim=0:${segmentDuration},asetpts=N/SR/TB[tone];` +
      `[voice][tone]amix=inputs=2:duration=longest:normalize=0,aresample=48000,apad,atrim=0:${segmentDuration},asetpts=N/SR/TB[out]`,
    "-map",
    "[out]",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-f",
    "mpegts",
    outputPath
  ]);
}

rmSync(mediaDir, { recursive: true, force: true });
rmSync(scratchDir, { recursive: true, force: true });
mkdirSync(mediaDir, { recursive: true });
mkdirSync(scratchDir, { recursive: true });

for (const clip of clips) {
  makeClip(clip);
}

rmSync(scratchDir, { recursive: true, force: true });
console.log(`Generated ${clips.length} audio HLS segments in ${mediaDir}`);
