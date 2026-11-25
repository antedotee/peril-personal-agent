/**
 * Voice memos to text on the Sprite with whisper.cpp, no API. iMessage audio is converted
 * to 16 kHz WAV with ffmpeg first. The audio file is deleted after transcription.
 */
import fs from "node:fs";

export function whisperTranscriber(opts: { whisperBin: string; model: string }): ((path: string) => Promise<string | undefined>) | undefined {
  if (!fs.existsSync(opts.model) || !Bun.which(opts.whisperBin) || !Bun.which("ffmpeg")) return undefined;
  return async (audio) => {
    const wav = `${audio}.wav`;
    try {
      const conv = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-i", audio, "-ar", "16000", "-ac", "1", wav], { stdout: "ignore", stderr: "ignore" });
      if ((await conv.exited) !== 0) return undefined;
      const run = Bun.spawn([opts.whisperBin, "-m", opts.model, "-f", wav, "-nt", "-np"], { stdout: "pipe", stderr: "ignore" });
      const text = (await new Response(run.stdout).text()).replace(/\s+/g, " ").trim();
      return (await run.exited) === 0 && text ? text : undefined;
    } finally {
      for (const f of [audio, wav]) fs.rmSync(f, { force: true });
    }
  };
}
