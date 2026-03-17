const express = require("express");
const cors = require("cors");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuid } = require("uuid");
const https = require("https");
const http = require("http");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 4000;
const SECRET = process.env.FFMPEG_SERVICE_SECRET || "dev-secret";
const WORK_DIR = "/tmp/ffmpeg-jobs";

if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

function authCheck(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    proto.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) return reject(new Error(`Download HTTP ${response.statusCode}`));
      const file = fs.createWriteStream(destPath);
      response.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", reject);
    }).on("error", reject);
  });
}

function runFFmpeg(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("FFmpeg timeout")); }, timeoutMs);
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`FFmpeg exit ${code}/${signal}: ${stderr.slice(-500)}`));
    });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function runProbe(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", filePath]);
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) { try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Parse error")); } }
      else reject(new Error("ffprobe failed"));
    });
    proc.on("error", reject);
  });
}

/**
 * Generate an ASS subtitle file with word-by-word highlight (karaoke-style).
 * For each word's time window, the full caption text is shown with
 * the current word in the highlight color. This creates the same
 * effect as the web player's word highlighting.
 */
function generateASS(captions, style, outW, outH) {
  const fontName = style?.fontFamily || "Arial";
  const fontSize = Math.round((style?.fontSize || 42) * (outW / 1080));
  const defaultColor = assColor(style?.textColor || "#ffffff");
  const highlightColor = assColor(style?.highlightColor || "#f59e0b");
  const outlineSize = Math.max(2, Math.round(fontSize / 12));
  const marginBottom = Math.round(outH * 0.10);
  const marginSide = Math.round(outW * 0.05); // 5% side margins for proper wrapping

  let ass = `[Script Info]
Title: Subtitles
ScriptType: v4.00+
PlayResX: ${outW}
PlayResY: ${outH}
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${defaultColor},${highlightColor},&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${outlineSize},0,2,${marginSide},${marginSide},${marginBottom},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  for (const cap of captions) {
    const words = cap.words;
    
    if (!words || words.length === 0) {
      // No word-level data — show plain caption
      const start = assTime(Math.max(0, cap.start));
      const end = assTime(cap.end);
      const text = escapeASS(cap.text);
      ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}\n`;
      continue;
    }

    // Generate one dialogue line per word timing — each shows full text
    // with the current word highlighted
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi];
      const wStart = assTime(Math.max(0, w.start));
      const wEnd = assTime(w.end);
      
      // Build the full caption text with highlight on current word
      let line = "";
      for (let j = 0; j < words.length; j++) {
        const word = escapeASS(words[j].word);
        if (j === wi) {
          // Highlighted word — use highlight color
          line += `{\\c${highlightColor}}${word}{\\c${defaultColor}} `;
        } else {
          line += `${word} `;
        }
      }
      
      ass += `Dialogue: 0,${wStart},${wEnd},Default,,0,0,0,,${line.trim()}\n`;
    }
  }

  return ass;
}

function escapeASS(text) {
  return (text || "")
    .replace(/[\u2018\u2019\u201A\u2039\u203A]/g, "'")  // curly quotes → straight
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\n/g, "\\N");
}

function assTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function assColor(hex) {
  // ASS color format: &HAABBGGRR (alpha, blue, green, red)
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `&H00${b}${g}${r}`.toUpperCase();
}

/**
 * Detect subject horizontal position using sharpness (focus detection).
 */
async function detectSubjectX(videoPath, segStart, segEnd, srcW, srcH, cropW) {
  const jobDir = path.dirname(videoPath);
  const sampleTimes = [
    segStart + (segEnd - segStart) * 0.25,
    segStart + (segEnd - segStart) * 0.50,
    segStart + (segEnd - segStart) * 0.75,
  ];
  
  const allCropXs = [];
  for (const timestamp of sampleTimes) {
    try {
      const cropX = await analyzeFrame(videoPath, timestamp, srcW, srcH, cropW, jobDir);
      allCropXs.push(cropX);
    } catch {}
  }
  
  if (allCropXs.length === 0) return Math.round((srcW - cropW) / 2);
  allCropXs.sort((a, b) => a - b);
  return allCropXs[Math.floor(allCropXs.length / 2)];
}

async function analyzeFrame(videoPath, timestamp, srcW, srcH, cropW, jobDir) {
  const probeW = 200;
  const probeH = Math.round(probeW * srcH / srcW);
  const framePath = path.join(jobDir, `probe_${Date.now()}_${Math.random().toString(36).slice(2,6)}.raw`);
  
  try {
    await runFFmpeg([
      "-ss", String(timestamp), "-i", videoPath,
      "-vframes", "1", "-vf", `scale=${probeW}:${probeH}`,
      "-f", "rawvideo", "-pix_fmt", "gray", "-y", framePath,
    ], 15000);

    const pixels = fs.readFileSync(framePath);
    if (pixels.length < probeW * probeH * 0.5) throw new Error("Frame too small");

    const yStart = Math.round(probeH * 0.05);
    const yEnd = Math.round(probeH * 0.60);
    const columnSharpness = new Float64Array(probeW);
    
    for (let x = 1; x < probeW - 1; x++) {
      let sharpness = 0, count = 0;
      for (let y = yStart; y < yEnd; y++) {
        const idx = y * probeW + x;
        if (idx + 1 < pixels.length && idx - 1 >= 0) {
          const gx = Math.abs(pixels[idx + 1] - pixels[idx - 1]);
          const idxUp = (y - 1) * probeW + x;
          const idxDown = (y + 1) * probeW + x;
          const gy = (idxUp >= 0 && idxDown < pixels.length) ? Math.abs(pixels[idxDown] - pixels[idxUp]) : 0;
          sharpness += gx + gy;
          count++;
        }
      }
      columnSharpness[x] = count > 0 ? sharpness / count : 0;
    }

    const centerX = probeW / 2;
    for (let x = 0; x < probeW; x++) {
      const dist = Math.abs(x - centerX) / centerX;
      columnSharpness[x] *= (1.0 - dist * 0.3);
    }

    const cropWidthInProbe = Math.round((cropW / srcW) * probeW);
    const halfW = Math.floor(cropWidthInProbe / 2);
    let bestCX = Math.floor(probeW / 2), bestScore = -1;
    for (let cx = halfW; cx < probeW - halfW; cx++) {
      let score = 0;
      for (let x = cx - halfW; x < cx + halfW; x++) score += columnSharpness[x];
      if (score > bestScore) { bestScore = score; bestCX = cx; }
    }

    const subjectCX = Math.round((bestCX / probeW) * srcW);
    let cropX = subjectCX - Math.round(cropW / 2);
    return Math.max(0, Math.min(cropX, srcW - cropW));
  } finally {
    try { fs.unlinkSync(framePath); } catch {}
  }
}

app.get("/health", (req, res) => {
  try {
    execSync("ffmpeg -version", { timeout: 5000 });
    res.json({ status: "ok" });
  } catch { res.status(500).json({ status: "error" }); }
});

app.post("/process", authCheck, async (req, res) => {
  const jobId = uuid().slice(0, 8);
  const jobDir = path.join(WORK_DIR, jobId);

  try {
    const { videoUrl, segments, format = "9:16", captions, captionStyle } = req.body;
    if (!videoUrl || !segments || segments.length === 0) {
      return res.status(400).json({ error: "videoUrl and segments required" });
    }

    fs.mkdirSync(jobDir, { recursive: true });

    console.log(`[${jobId}] Downloading...`);
    const srcPath = path.join(jobDir, "source.mp4");
    await downloadFile(videoUrl, srcPath);
    console.log(`[${jobId}] Downloaded: ${(fs.statSync(srcPath).size / 1024 / 1024).toFixed(1)} MB`);

    const probe = await runProbe(srcPath);
    const vs = probe.streams.find((s) => s.codec_type === "video");
    const srcW = vs?.width || 1920;
    const srcH = vs?.height || 1080;

    const isOriginal = format === "original";
    const targetRatios = { "9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1 };
    const targetRatio = targetRatios[format] || 9 / 16;
    
    let outW, outH;
    if (isOriginal) {
      outW = srcW;
      outH = srcH;
    } else {
      outW = 720; outH = 1280;
      if (format === "16:9") { outW = 1280; outH = 720; }
      else if (format === "1:1") { outW = 720; outH = 720; }
    }

    let cropW, cropH, cropY;
    if (isOriginal) {
      cropW = srcW;
      cropH = srcH;
      cropY = 0;
    } else {
      const srcRatio = srcW / srcH;
      if (srcRatio > targetRatio) {
        cropH = srcH;
        cropW = Math.round(srcH * targetRatio);
        cropY = 0;
      } else {
        cropW = srcW;
        cropH = Math.round(srcW / targetRatio);
        cropY = Math.round((srcH - cropH) / 2);
      }
    }

    // Generate ASS subtitle file if captions provided
    let assPath = null;
    if (captions && captions.length > 0) {
      const assContent = generateASS(captions, captionStyle, outW, outH);
      assPath = path.join(jobDir, "subs.ass");
      fs.writeFileSync(assPath, assContent);
      console.log(`[${jobId}] Subtitles: ${captions.length} captions written to ASS`);
    }

    // Process each segment
    const segPaths = [];
    let clipTimeOffset = 0;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const dur = seg.end - seg.start;
      const segPath = path.join(jobDir, `seg${i}.mp4`);
      segPaths.push(segPath);

      console.log(`[${jobId}] Seg ${i + 1}/${segments.length}: ${seg.start}s → ${seg.end}s`);

      // Build video filter chain
      let vf;
      if (isOriginal) {
        // No crop, no scale — keep original dimensions
        vf = "null";  // passthrough filter
      } else {
        // Crop + scale for target format (e.g. 9:16)
        let cropX = Math.round((srcW - cropW) / 2);
        const srcRatio = srcW / srcH;
        if (srcRatio > targetRatio) {
          try {
            cropX = await detectSubjectX(srcPath, seg.start, seg.end, srcW, srcH, cropW);
          } catch {}
        }
        vf = `crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${outW}:${outH}`;
      }

      // Burn subtitles if available
      if (assPath) {
        if (segments.length > 1) {
          const segCaps = captions.filter(c => c.start >= clipTimeOffset - 0.1 && c.end <= clipTimeOffset + dur + 0.1);
          const shiftedCaps = segCaps.map(c => ({
            text: c.text,
            start: c.start - clipTimeOffset,
            end: c.end - clipTimeOffset,
            words: (c.words || []).map(w => ({
              word: w.word,
              start: w.start - clipTimeOffset,
              end: w.end - clipTimeOffset,
            })),
          }));
          if (shiftedCaps.length > 0) {
            const segAssContent = generateASS(shiftedCaps, captionStyle, outW, outH);
            const segAssPath = path.join(jobDir, `subs_${i}.ass`);
            fs.writeFileSync(segAssPath, segAssContent);
            const escapedPath = segAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");
            vf = vf === "null" ? `ass='${escapedPath}'` : `${vf},ass='${escapedPath}'`;
          }
        } else {
          const escapedPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
          vf = vf === "null" ? `ass='${escapedPath}'` : `${vf},ass='${escapedPath}'`;
        }
      }

      // Build FFmpeg args
      const ffArgs = [
        "-ss", String(seg.start),
        "-t", String(dur),
        "-i", srcPath,
      ];
      
      // Only add -vf if we have filters to apply
      if (vf !== "null") {
        ffArgs.push("-vf", vf);
      }
      
      ffArgs.push(
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", isOriginal ? "22" : "25",
        "-c:a", "aac",
        "-b:a", isOriginal ? "128k" : "96k",
        "-ac", isOriginal ? "2" : "1",
        "-movflags", "+faststart",
        "-threads", "1",
        "-y", segPath,
      );

      await runFFmpeg(ffArgs);

      clipTimeOffset += dur;
    }

    let outputPath;
    if (segPaths.length === 1) {
      outputPath = segPaths[0];
    } else {
      const concatFile = path.join(jobDir, "concat.txt");
      fs.writeFileSync(concatFile, segPaths.map((p) => `file '${p}'`).join("\n"));
      outputPath = path.join(jobDir, "output.mp4");
      await runFFmpeg(["-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", "-movflags", "+faststart", "-y", outputPath]);
    }

    const outSize = fs.statSync(outputPath).size;
    console.log(`[${jobId}] Done! ${(outSize / 1024 / 1024).toFixed(1)} MB`);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="clip-${jobId}.mp4"`);
    res.setHeader("Content-Length", outSize);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => fs.rmSync(jobDir, { recursive: true, force: true }));
  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: error.message || "Processing failed" });
  }
});

app.listen(PORT, () => console.log(`FFmpeg service on port ${PORT}`));
