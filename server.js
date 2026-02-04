const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();

// 你影片庫位置：改成你的路徑（例如 D:\Movies）
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || "./videos");

// HLS 快取位置（自動建立）
const CACHE_ROOT = path.resolve(process.env.CACHE_ROOT || "./cache");

// 允許的影片副檔名
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".mov", ".m4v", ".webm"]);

// 每次 HLS 分段秒數（1 秒起播很快）
const HLS_TIME = 1;

// ✅ 分開限制
const MAX_HLS = 10000;      // 同時轉 HLS 任務
const MAX_THUMB = 3;    // 同時生成縮圖任務

let runningHls = 0;
let runningThumb = 0;

const hlsJobs = new Map(); // id -> Promise

app.use(express.static(path.join(__dirname, "public")));
app.use("/cache", express.static(CACHE_ROOT, { fallthrough: false }));
app.use("/hls", express.static(CACHE_ROOT, {
  setHeaders: (res, filePath) => {
    const p = filePath.toLowerCase();
    if (p.endsWith(".m3u8")) res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    if (p.endsWith(".ts"))   res.setHeader("Content-Type", "video/mp2t");
  }
}));

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function walk(dir, out = []) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walk(full, out);
    else {
      const ext = path.extname(it.name).toLowerCase();
      if (VIDEO_EXTS.has(ext)) out.push(full);
    }
  }
  return out;
}

// 建索引（簡單快取）
let indexCache = null;
let indexBuiltAt = 0;
function buildIndexIfNeeded() {
  const now = Date.now();
  if (indexCache && now - indexBuiltAt < 20_000) return indexCache;

  const files = walk(VIDEO_ROOT);
  indexCache = files.map((abs) => {
    const rel = path.relative(VIDEO_ROOT, abs).replaceAll("\\", "/");
    const id = Buffer.from(rel).toString("base64url"); // url-safe
    return { id, name: path.basename(abs), relPath: rel };
  });

  indexBuiltAt = now;
  return indexCache;
}

function idToRelPath(id) {
  try {
    return Buffer.from(id, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function safeAbsFromRel(rel) {
  const safeRel = rel.replaceAll("\\", "/");
  const abs = path.resolve(VIDEO_ROOT, safeRel);
  if (!abs.startsWith(VIDEO_ROOT)) return null;
  return abs;
}

// 影片列表 + 搜尋
app.get("/api/videos", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const list = buildIndexIfNeeded();
  const results = q
    ? list.filter(v => (v.name + " " + v.relPath).toLowerCase().includes(q))
    : list;
  res.json(results.slice(0, 300));
});

// 取得單一影片資訊
app.get("/api/video/:id", (req, res) => {
  const rel = idToRelPath(req.params.id);
  if (!rel) return res.status(400).json({ error: "bad id" });

  const abs = safeAbsFromRel(rel);
  if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: "not found" });

  res.json({
    id: req.params.id,
    name: path.basename(abs),
    relPath: rel,
    hlsUrl: `/api/hls/${req.params.id}/index.m3u8`, // 入口
  });
});

function probeCodecs(absInput) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-v", "error",
      "-print_format", "json",
      "-show_streams",
      absInput
    ];
    const p = spawn("ffprobe", args, { windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffprobe failed: " + err));
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find(s => s.codec_type === "video");
        const a = (j.streams || []).find(s => s.codec_type === "audio");
        resolve({
          vcodec: v?.codec_name || "",
          acodec: a?.codec_name || ""
        });
      } catch (e) {
        reject(e);
      }
    });
    p.on("error", reject);
  });
}

async function ensureHls(id, absInput){
  // 🔒 已有任務在跑 → 共用（避免重複 spawn）
  if (hlsJobs.has(id)) return hlsJobs.get(id);

  const job = new Promise(async (resolve, reject) => {
    let spawned = false;
    let released = false; // 是否已「放行」給播放器

    try {
      const outDir  = path.join(CACHE_ROOT, id);
      const outM3u8 = path.join(outDir, "index.m3u8");
      ensureDir(outDir);

      // 已存在（之前跑過）→ 直接用
      if (fs.existsSync(outM3u8)) {
        return resolve({ ready: true, outM3u8 });
      }

      // 🚦 限流
      if (runningHls >= MAX_HLS) {
        return resolve({ ready: false, busy: true });
      }
      runningHls++;

      /* ========= probe codec ========= */
      const vcodec = await probeCodec(absInput, "v");
      const acodec = await probeCodec(absInput, "a");
      const isH264 = (vcodec === "h264");

      /* ========= 編碼決策 ========= */
      let vArgs;
      // 音訊一律轉 AAC（避 AC3/DTS）
      let aArgs = ["-c:a", "aac", "-b:a", "128k"];

      if (isH264) {
        // ⭐ 老動畫王道：直接 copy（最快）
        vArgs = ["-c:v", "copy"];
      } else {
        // ⭐ 非 H.264 → GPU AMF + 動畫友善 preset
        vArgs = [
          "-c:v", "h264_amf",
          "-usage", "transcoding",
          "-quality", "speed",
          "-rc", "cqp",
          "-qp_i", "22",
          "-qp_p", "24",
          "-qp_b", "26",
          // 動畫降到 480p，起播更快、轉碼更短
          "-vf", "scale=-2:480"
        ];
      }

      /* ========= ffmpeg args（即時寫 HLS） ========= */
      const args = [
        "-hide_banner", "-y",

        // ⭐ 防止 MKV 前處理假卡死
        "-analyzeduration", "100M",
        "-probesize", "100M",
        "-fflags", "+genpts",

        "-i", absInput,

        ...vArgs,
        ...aArgs,

        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-sn",

        // ⭐ 老片/亂 GOP 必備
        "-force_key_frames", "expr:gte(t,n_forced*2)",

        "-f", "hls",
        "-hls_time", "2",
        "-hls_list_size", "6",
		"-hls_playlist_type", "event",
        "-hls_segment_type", "mpegts",
        "-hls_flags", "independent_segments+split_by_time",

        outM3u8
      ];

      console.log("[HLS] spawn ffmpeg:", absInput);
      const p = spawn("ffmpeg", args, { windowsHide: true });
      spawned = true;

      // 👀 把 ffmpeg 進度吐出來（全部在 stderr）
      p.stderr.on("data", d => {
        const s = d.toString();
        console.log("[ffmpeg]", s);
      });

      // ⭐⭐ 即時放行：只要 m3u8 出現就 resolve（邊轉邊播）
      const waitM3U8 = setInterval(() => {
        if (!released && fs.existsSync(outM3u8)) {
          released = true;
          clearInterval(waitM3U8);
          resolve({ ready: true, outM3u8, streaming: true });
        }
      }, 200);

      // ffmpeg 結束：只做清理（播放已在跑）
      p.on("close", (code) => {
        runningHls--;
        console.log("[HLS] ffmpeg closed, code =", code);
        clearInterval(waitM3U8);
        // 若還沒放行但檔已生成，也補放行
        if (!released && fs.existsSync(outM3u8)) {
          released = true;
          resolve({ ready: true, outM3u8 });
        }
        if (code !== 0 && !released) {
          reject(new Error("ffmpeg failed, code=" + code));
        }
      });

      p.on("error", (err) => {
        runningHls--;
        clearInterval(waitM3U8);
        if (!released) reject(err);
      });

    } catch (e) {
      if (spawned) runningHls = Math.max(0, runningHls - 1);
      reject(e);
    }
  });

  hlsJobs.set(id, job);
  job.finally(() => hlsJobs.delete(id));
  return job;
}


function probeCodec(file, type){
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", `${type}:0`,
      "-show_entries", "stream=codec_name",
      "-of", "default=nk=1:nw=1",
      file
    ], { windowsHide: true });

    let out = "";
    p.stdout.on("data", d => out += d.toString());
    p.on("close", () => resolve(out.trim() || "none"));
    p.on("error", () => resolve("none"));
  });
}


// HLS 入口：如果沒生成就生成；忙碌就回 202
app.get("/api/hls/:id/index.m3u8", async (req, res) => {
  const { id } = req.params;

  const absInput = resolveVideoPathById(id); // 你原本就有
  const outDir = path.join(CACHE_ROOT, id);
  const m3u8Path = path.join(outDir, "index.m3u8");

  // 1️⃣ 確保 ffmpeg 已啟動（但不等完成）
  const r = await ensureHls(id, absInput);
  if (r.busy) {
    return res.status(202).end();
  }

  // 2️⃣ 等「m3u8 檔案出現」（通常 < 1 秒）
  await new Promise(resolve => {
    const t = setInterval(() => {
      if (fs.existsSync(m3u8Path)) {
        clearInterval(t);
        resolve();
      }
    }, 100);
  });

  // 3️⃣ 用 stream 方式回傳（關鍵）
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  fs.createReadStream(m3u8Path).pipe(res);
});

app.get("/api/hls/:id/:seg", (req, res) => {
  const { id, seg } = req.params;

  // 只允許 .ts（安全）
  if (!seg.endsWith(".ts")) {
    return res.status(404).end();
  }

  const segPath = path.join(CACHE_ROOT, id, seg);

  // 還沒生成 → 告訴播放器稍後再來
  if (!fs.existsSync(segPath)) {
    return res.status(404).end();
  }

  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Cache-Control", "no-cache, no-store");

  // ⭐ 關鍵：stream（允許邊寫邊讀）
  fs.createReadStream(segPath).pipe(res);
});


// ✅ 列出某資料夾下的子資料夾與影片（不遞迴）
app.get("/api/browse", (req, res) => {
  const dir = String(req.query.dir || "").replaceAll("\\", "/").replace(/^\/+/, "");
  const absDir = path.resolve(VIDEO_ROOT, dir);

  // 防止路徑穿越
  if (!absDir.startsWith(VIDEO_ROOT)) return res.status(403).json({ error: "forbidden" });
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    return res.status(404).json({ error: "dir not found" });
  }

  const items = fs.readdirSync(absDir, { withFileTypes: true });

  const folders = [];
  const videos = [];

  for (const it of items) {
    if (it.isDirectory()) {
      const relPath = path.join(dir, it.name).replaceAll("\\", "/");
      folders.push({
        name: it.name,
        relPath,
      });
    } else if (it.isFile()) {
      const ext = path.extname(it.name).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) continue;

      const relPath = path.join(dir, it.name).replaceAll("\\", "/");
      const id = Buffer.from(relPath).toString("base64url");
      videos.push({
        id,
        name: it.name,
        relPath,
      });
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  videos.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));

  const parent = dir ? dir.split("/").slice(0, -1).join("/") : null;

  res.json({ dir, parent, folders, videos });
});

const THUMB_DIR = path.join(CACHE_ROOT, "thumbs");
ensureDir(THUMB_DIR);

function absFromId(id) {
  const rel = idToRelPath(id);
  if (!rel) return null;
  const abs = path.resolve(VIDEO_ROOT, rel.replaceAll("\\", "/"));
  if (!abs.startsWith(VIDEO_ROOT)) return null;
  return fs.existsSync(abs) ? abs : null;
}

// ✅ 縮圖：第一次生成，之後直接回快取
app.get("/api/thumb/:id.jpg", async (req, res) => {
  const id = req.params.id;
  const abs = absFromId(id);
  if (!abs) return res.status(404).send("not found");

  const outJpg = path.join(THUMB_DIR, `${id}.jpg`);

  // 已存在就直接回
  if (fs.existsSync(outJpg)) {
    res.setHeader("Content-Type", "image/jpeg");
    return fs.createReadStream(outJpg).pipe(res);
  }
  
  // ✅ 縮圖限流：忙碌就回 202（不是錯誤）
  if (runningThumb >= MAX_THUMB) {
	return res.status(202).end();
  }
  runningThumb++;
  // 生成縮圖：取 10% 時間點（避免片頭黑畫面）
  // 若 ffprobe 取不到時長也沒關係，會 fallback 用 00:00:03
  let ss = "00:00:03";
  try {
    const dur = await new Promise((resolve) => {
      const p = spawn("ffprobe", [
        "-hide_banner", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nk=1:nw=1",
        abs
      ], { windowsHide: true });

      let out = "";
      p.stdout.on("data", d => out += d.toString());
      p.on("close", () => resolve(parseFloat(out)));
      p.on("error", () => resolve(NaN));
    });

    if (Number.isFinite(dur) && dur > 30) {
      const t = Math.floor(dur * 0.1);
      const hh = String(Math.floor(t / 3600)).padStart(2, "0");
      const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
      const ss2 = String(t % 60).padStart(2, "0");
      ss = `${hh}:${mm}:${ss2}`;
    }
  } catch {}

  // ffmpeg 生成縮圖（速度快，且不需要轉碼整部）
  // scale=-2:360 讓寬度自動等比，手機列表很夠用
  const args = [
    "-hide_banner", "-y",
    "-ss", ss,
    "-i", abs,
    "-frames:v", "1",
    "-vf", "scale=-2:360",
    "-q:v", "3",
    outJpg
  ];

  const p = spawn("ffmpeg", args, { windowsHide: true });

	p.on("close", (code) => {
	  runningThumb--;
	  if (code === 0 && fs.existsSync(outJpg)) {
		res.setHeader("Content-Type", "image/jpeg");
		fs.createReadStream(outJpg).pipe(res);
	  } else {
		res.status(500).send("thumb failed");
	  }
	});

	p.on("error", () => {
	  runningThumb--;
	  res.status(500).send("thumb failed");
	});
});


const PORT = process.env.PORT || 8787;
ensureDir(CACHE_ROOT);

app.listen(PORT, "0.0.0.0", () => {
  console.log("VIDEO_ROOT =", VIDEO_ROOT);
  console.log("CACHE_ROOT =", CACHE_ROOT);
  console.log(`Open: http://localhost:${PORT}`);
});
