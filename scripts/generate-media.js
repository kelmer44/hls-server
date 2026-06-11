import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const mediaDir = path.join(rootDir, "public", "media");
const scratchDir = path.join(rootDir, ".generated-audio");

const segmentDuration = 6;

const clips = [
  { name: "content-1", phrase: "This is content chunk number one." },
  { name: "content-2", phrase: "This is content chunk number two." },
  { name: "content-3", phrase: "This is content chunk number three." },
  { name: "content-4", phrase: "This is content chunk number four." },
  { name: "content-5", phrase: "This is content chunk number five." },
  { name: "content-6", phrase: "This is content chunk number six." },
  { name: "broadcast-ad", phrase: "This is a broadcast ad. This is a broadcast ad." },
  { name: "interstitial", phrase: "Interstitial ad. This audio should replace the broadcast ad." }
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

function makeClip({ name, phrase }) {
  const voicePath = path.join(scratchDir, `${name}.aiff`);
  const outputPath = path.join(mediaDir, `${name}.ts`);

  run("say", ["-o", voicePath, phrase]);
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    voicePath,
    "-filter:a",
    `aresample=48000,volume=20,apad,atrim=0:${segmentDuration},alimiter=limit=0.95,asetpts=N/SR/TB`,
    "-map",
    "0:a",
    "-ac",
    "2",
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
