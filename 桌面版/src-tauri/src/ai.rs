//! Offline AI features (Cargo feature "ai"): Whisper transcription + local LLM
//! note generation. Compiled only into the full edition; the lite edition is
//! built with --no-default-features and never includes this module.

use super::*;
use std::io::Read as _;

// ---------- Offline AI: Whisper transcription + local LLM note generation ----------
pub struct AiState(pub Mutex<AiRuntime>);
#[derive(Default)]
pub struct AiRuntime { download: Option<Arc<Mutex<DownloadShared>>>, proc: Option<Arc<Mutex<ProcShared>>>, audio: HashMap<String, PathBuf> }
#[derive(Default, Clone)]
struct DownloadShared { label: String, received: u64, total: u64, done: bool, cancelled: bool, error: Option<String> }
#[derive(Default)]
struct ProcShared { kind: String, progress: i32, output: String, stderr_tail: String, done: bool, error: Option<String>, child: Option<std::process::Child> }

const WHISPER_MODELS: [(&str, &str, &str); 4] = [
    ("base", "基础 base（较快，普通话一般）", "ggml-base.bin"),
    ("small", "均衡 small（推荐，普通话较好）", "ggml-small.bin"),
    ("medium", "精准 medium（较慢，普通话更好）", "ggml-medium.bin"),
    ("turbo", "大型 large-v3-turbo（多语言最佳，约 1.6 GB）", "ggml-large-v3-turbo.bin"),
];
const LLM_MODELS: [(&str, &str, &str, &str); 2] = [
    ("qwen15", "Qwen2.5 1.5B（快速）", "qwen2.5-1.5b-instruct-q4_k_m.gguf", "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"),
    ("qwen3", "Qwen2.5 3B（推荐，质量更好）", "qwen2.5-3b-instruct-q4_k_m.gguf", "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"),
];

fn ai_dirs(state: &State<AppState>) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let rt = state.0.lock().unwrap();
    require_user(&rt)?;
    let data = rt.paths.as_ref().ok_or("数据目录不可用")?.data.clone();
    let models = data.join("ai-models");
    let engines = data.join("ai-engines");
    let audio = data.join("ai-audio");
    for d in [&models, &engines, &audio] { fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    Ok((models, engines, audio))
}
fn pref_value(state: &State<AppState>, key: &str) -> Option<String> {
    let rt = state.0.lock().unwrap();
    rt.db.as_ref()?.query_row("SELECT value FROM preferences WHERE key=?", [key], |r| r.get::<_, String>(0)).optional().ok().flatten().filter(|s| !s.is_empty())
}
fn find_exe(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    if !dir.exists() { return None; }
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() { stack.push(p); } else if let Some(n) = p.file_name().and_then(|x| x.to_str()) { if names.iter().any(|w| *w == n) { return Some(p); } }
            }
        }
    }
    None
}
fn resolve_engine(state: &State<AppState>, engines: &Path, which: &str) -> Option<PathBuf> {
    let (pref_key, names): (&str, &[&str]) = if which == "whisper" {
        ("aiWhisperPath", if cfg!(windows) { &["whisper-cli.exe", "main.exe"] } else { &["whisper-cli", "main"] })
    } else {
        ("aiLlamaPath", if cfg!(windows) { &["llama-cli.exe"] } else { &["llama-cli"] })
    };
    if let Some(p) = pref_value(state, pref_key) { let pb = PathBuf::from(p); if pb.exists() { return Some(pb); } }
    if let Some(p) = find_exe(&engines.join(which), names) { return Some(p); }
    let mut candidates: Vec<PathBuf> = vec![];
    if cfg!(target_os = "macos") { candidates.push(PathBuf::from("/opt/homebrew/bin").join(names[0])); candidates.push(PathBuf::from("/usr/local/bin").join(names[0])); }
    if let Ok(path_var) = std::env::var("PATH") { for part in path_var.split(if cfg!(windows) { ';' } else { ':' }) { if !part.is_empty() { candidates.push(PathBuf::from(part).join(names[0])); } } }
    candidates.into_iter().find(|p| p.exists())
}
fn model_file(models: &Path, kind: &str, id: &str) -> Option<(String, PathBuf)> {
    if kind == "whisper" { WHISPER_MODELS.iter().find(|m| m.0 == id).map(|m| (m.2.to_string(), models.join(m.2))) }
    else { LLM_MODELS.iter().find(|m| m.0 == id).map(|m| (m.2.to_string(), models.join(m.2))) }
}
fn engine_download_url(which: &str) -> Option<String> {
    let os = std::env::consts::OS; let arch = std::env::consts::ARCH;
    match (which, os) {
        ("whisper", "windows") => Some("https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip".into()),
        ("llama", "windows") => Some("https://github.com/ggml-org/llama.cpp/releases/download/b6123/llama-b6123-bin-win-cpu-x64.zip".into()),
        ("llama", "macos") => Some(format!("https://github.com/ggml-org/llama.cpp/releases/download/b6123/llama-b6123-bin-macos-{}.zip", if arch == "aarch64" { "arm64" } else { "x64" })),
        _ => None,
    }
}

#[tauri::command]
pub fn ai_status(state: State<AppState>, ai: State<AiState>) -> Result<Value, String> {
    let (models, engines, _audio) = ai_dirs(&state)?;
    let whisper = resolve_engine(&state, &engines, "whisper");
    let llama = resolve_engine(&state, &engines, "llama");
    let mut model_list: Vec<Value> = vec![];
    for (id, label, file) in WHISPER_MODELS { let p = models.join(file); model_list.push(json!({"id": id, "kind": "whisper", "label": label, "file": file, "downloaded": p.exists(), "bytes": p.metadata().map(|m| m.len()).unwrap_or(0)})); }
    for (id, label, file, _url) in LLM_MODELS { let p = models.join(file); model_list.push(json!({"id": id, "kind": "llm", "label": label, "file": file, "downloaded": p.exists(), "bytes": p.metadata().map(|m| m.len()).unwrap_or(0)})); }
    if let Ok(rd) = fs::read_dir(&models) { for e in rd.flatten() { let n = e.file_name().to_string_lossy().to_string(); let known = WHISPER_MODELS.iter().any(|m| m.2 == n) || LLM_MODELS.iter().any(|m| m.2 == n); if !known && (n.ends_with(".bin") || n.ends_with(".gguf")) { model_list.push(json!({"id": format!("custom:{}", n), "kind": if n.ends_with(".bin") { "whisper" } else { "llm" }, "label": format!("自定义模型 {}", n), "file": n, "downloaded": true, "bytes": e.metadata().map(|m| m.len()).unwrap_or(0)})); } } }
    let rt = ai.0.lock().unwrap();
    let download = rt.download.as_ref().map(|d| { let s = d.lock().unwrap(); json!({"label": s.label, "received": s.received, "total": s.total, "done": s.done, "error": s.error}) });
    let proc = rt.proc.as_ref().map(|p| { let s = p.lock().unwrap(); json!({"kind": s.kind, "done": s.done}) });
    Ok(json!({"whisper": {"found": whisper.is_some(), "path": whisper.map(|p| p.to_string_lossy().to_string())}, "llama": {"found": llama.is_some(), "path": llama.map(|p| p.to_string_lossy().to_string())}, "models": model_list, "modelsDir": models.to_string_lossy(), "enginesDir": engines.to_string_lossy(), "os": std::env::consts::OS, "download": download, "proc": proc}))
}

#[tauri::command]
pub fn ai_download(state: State<AppState>, ai: State<AiState>, what: String) -> Result<bool, String> {
    let (models, engines, _a) = ai_dirs(&state)?;
    let (url, dest, extract_to, label): (String, PathBuf, Option<PathBuf>, String) = if let Some(w) = what.strip_prefix("engine-") {
        let url = engine_download_url(w).ok_or("当前系统暂无可自动下载的引擎包，请使用自定义引擎路径（macOS 可先通过 Homebrew 安装 whisper-cpp / llama.cpp）")?;
        (url.clone(), engines.join(format!("{}-engine.zip", w)), Some(engines.join(w)), format!("{} 引擎", w))
    } else if let Some(id) = what.strip_prefix("whisper-") {
        let (_f, p) = model_file(&models, "whisper", id).ok_or("未知模型")?;
        (format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}", p.file_name().unwrap().to_string_lossy()), p, None, format!("Whisper {} 模型", id))
    } else if let Some(id) = what.strip_prefix("llm-") {
        let m = LLM_MODELS.iter().find(|m| m.0 == id).ok_or("未知模型")?;
        (m.3.to_string(), models.join(m.2), None, format!("笔记生成 {} 模型", id))
    } else { return Err("未知下载项".into()); };
    let shared = Arc::new(Mutex::new(DownloadShared { label, ..Default::default() }));
    { let mut rt = ai.0.lock().unwrap(); if let Some(d) = &rt.download { if !d.lock().unwrap().done { return Err("已有下载正在进行".into()); } } rt.download = Some(shared.clone()); }
    std::thread::spawn(move || {
        let fail = |shared: &Arc<Mutex<DownloadShared>>, msg: String| { let mut s = shared.lock().unwrap(); s.error = Some(msg); s.done = true; };
fn ai_http_agent() -> ureq::Agent {
    // Downloads verify certificates against the OS trust store (native TLS), so
    // institutional CAs / security software on user machines keep working, and
    // honor proxy environment variables when present.
    let mut builder = ureq::AgentBuilder::new();
    if let Ok(connector) = native_tls::TlsConnector::new() { builder = builder.tls_connector(std::sync::Arc::new(connector)); }
    let proxy_url = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"].iter().find_map(|k| std::env::var(k).ok()).filter(|v| !v.is_empty());
    if let Some(u) = proxy_url { if let Ok(proxy) = ureq::Proxy::new(&u) { builder = builder.proxy(proxy); } }
    builder.build()
}
        let agent = ai_http_agent();
        let resp = match agent.get(&url).call() { Ok(r) => r, Err(e) => { fail(&shared, format!("下载失败：{}", e)); return; } };
        let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
        { let mut s = shared.lock().unwrap(); s.total = total; }
        let mut reader = resp.into_reader();
        let mut file = match fs::File::create(&dest) { Ok(f) => f, Err(e) => { fail(&shared, e.to_string()); return; } };
        let mut buf = vec![0u8; 65536]; let mut received: u64 = 0;
        loop {
            if shared.lock().unwrap().cancelled { drop(file); let _ = fs::remove_file(&dest); fail(&shared, "已取消".into()); return; }
            match reader.read(&mut buf) { Ok(0) => break, Ok(n) => { use std::io::Write as _; if file.write_all(&buf[..n]).is_err() { fail(&shared, "写入失败".into()); return; } received += n as u64; shared.lock().unwrap().received = received; }, Err(e) => { fail(&shared, format!("下载中断：{}", e)); return; } }
        }
        drop(file);
        if let Some(dir) = extract_to {
            let f = match fs::File::open(&dest) { Ok(f) => f, Err(e) => { fail(&shared, e.to_string()); return; } };
            let mut zip = match zip::ZipArchive::new(f) { Ok(z) => z, Err(e) => { fail(&shared, format!("解压失败：{}", e)); return; } };
            if let Err(e) = zip.extract(&dir) { fail(&shared, format!("解压失败：{}", e)); return; }
            let _ = fs::remove_file(&dest);
            #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let mut stack = vec![dir.clone()]; while let Some(d) = stack.pop() { if let Ok(rd) = fs::read_dir(&d) { for e in rd.flatten() { let p = e.path(); if p.is_dir() { stack.push(p); } else { let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o755)); } } } } }
        }
        let mut s = shared.lock().unwrap(); s.done = true;
    });
    Ok(true)
}
#[tauri::command]
pub fn ai_download_cancel(ai: State<AiState>) -> Result<bool, String> { let rt = ai.0.lock().unwrap(); if let Some(d) = &rt.download { d.lock().unwrap().cancelled = true; } Ok(true) }
#[tauri::command]
pub fn ai_set_engine_path(state: State<AppState>, which: String, path: String) -> Result<bool, String> {
    let key = if which == "whisper" { "aiWhisperPath" } else { "aiLlamaPath" };
    let rt = state.0.lock().unwrap(); require_user(&rt)?;
    rt.db.as_ref().unwrap().execute("INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, path]).map_err(|e| e.to_string())?; Ok(true)
}
#[tauri::command]
pub fn ai_import_model(state: State<AppState>, kind: String, src: String) -> Result<String, String> {
    let (models, _e, _a) = ai_dirs(&state)?;
    let srcp = PathBuf::from(&src); let name = srcp.file_name().ok_or("路径无效")?.to_string_lossy().to_string();
    if kind == "whisper" && !name.ends_with(".bin") { return Err("Whisper 模型应为 .bin 文件".into()); }
    if kind == "llm" && !name.ends_with(".gguf") { return Err("笔记生成模型应为 .gguf 文件".into()); }
    fs::copy(&srcp, models.join(&name)).map_err(|e| e.to_string())?; Ok(name)
}
#[tauri::command]
pub fn audio_begin(state: State<AppState>, ai: State<AiState>) -> Result<Value, String> {
    let (_m, _e, audio) = ai_dirs(&state)?;
    let id = Uuid::new_v4().to_string(); let path = audio.join(format!("{}.wav", id));
    fs::write(&path, []).map_err(|e| e.to_string())?;
    ai.0.lock().unwrap().audio.insert(id.clone(), path.clone());
    Ok(json!({"id": id, "path": path.to_string_lossy()}))
}
#[tauri::command]
pub fn audio_append(ai: State<AiState>, id: String, data: String) -> Result<bool, String> {
    use base64::Engine as _;
    let path = { let rt = ai.0.lock().unwrap(); rt.audio.get(&id).cloned().ok_or("录音会话不存在")? };
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new().append(true).open(&path).map_err(|e| e.to_string())?;
    use std::io::Write as _; f.write_all(&bytes).map_err(|e| e.to_string())?; Ok(true)
}
#[tauri::command]
pub fn audio_finish(ai: State<AiState>, id: String) -> Result<Value, String> {
    let rt = ai.0.lock().unwrap(); let path = rt.audio.get(&id).cloned().ok_or("录音会话不存在")?;
    Ok(json!({"path": path.to_string_lossy(), "bytes": path.metadata().map(|m| m.len()).unwrap_or(0)}))
}
#[tauri::command]
pub fn audio_discard(state: State<AppState>, path: String) -> Result<bool, String> {
    let (_m, _e, audio) = ai_dirs(&state)?;
    let p = PathBuf::from(&path); if p.starts_with(&audio) { let _ = fs::remove_file(p); } Ok(true)
}
fn spawn_proc(ai: &State<AiState>, kind: &str, mut cmd: std::process::Command) -> Result<bool, String> {
    use std::io::Read as _;
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).stdin(std::process::Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt as _; cmd.creation_flags(0x08000000); }
    let mut child = cmd.spawn().map_err(|e| format!("引擎启动失败：{}", e))?;
    let out = child.stdout.take(); let err = child.stderr.take();
    let shared = Arc::new(Mutex::new(ProcShared { kind: kind.to_string(), progress: -1, ..Default::default() }));
    shared.lock().unwrap().child = Some(child);
    if let Some(mut so) = out { let sh = shared.clone(); std::thread::spawn(move || { let mut b = [0u8; 4096]; loop { match so.read(&mut b) { Ok(0) => break, Ok(n) => { sh.lock().unwrap().output.push_str(&String::from_utf8_lossy(&b[..n])); }, Err(_) => break } } }); }
    if let Some(se) = err { let sh = shared.clone(); std::thread::spawn(move || { use std::io::BufRead as _; let reader = std::io::BufReader::new(se); for line in reader.lines() { if let Ok(l) = line { let mut s = sh.lock().unwrap(); if let Some(pos) = l.rfind('%') { if let Some(num) = l[..pos].rsplit(|c: char| !c.is_ascii_digit()).next() { if let Ok(v) = num.parse::<i32>() { s.progress = v; } } } let tail = format!("{}\n{}", s.stderr_tail, l); s.stderr_tail = tail.chars().rev().take(1500).collect::<String>().chars().rev().collect(); } } }); }
    { let mut rt = ai.0.lock().unwrap(); rt.proc = Some(shared); }
    Ok(true)
}
#[tauri::command]
pub fn transcribe_start(state: State<AppState>, ai: State<AiState>, audio_path: String, model: String, lang: String) -> Result<bool, String> {
    let (models, engines, _a) = ai_dirs(&state)?;
    let bin = resolve_engine(&state, &engines, "whisper").ok_or("未找到转写引擎（whisper-cli）。请先在智能记录页下载引擎，或设置自定义引擎路径。")?;
    let model_path = if let Some(f) = model.strip_prefix("custom:") { models.join(f) } else { model_file(&models, "whisper", &model).ok_or("未知模型")?.1 };
    if !model_path.exists() { return Err("所选模型尚未下载".into()); }
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("-m").arg(&model_path).arg("-f").arg(&audio_path).arg("-l").arg(if lang.is_empty() { "auto".to_string() } else { lang }).arg("--no-timestamps").arg("-pp").arg("-t").arg("4");
    spawn_proc(&ai, "transcribe", cmd)
}
#[tauri::command]
pub fn generate_start(state: State<AppState>, ai: State<AiState>, model: String, prompt: String) -> Result<bool, String> {
    let (models, engines, _a) = ai_dirs(&state)?;
    let bin = resolve_engine(&state, &engines, "llama").ok_or("未找到笔记生成引擎（llama-cli）。请先在智能记录页下载引擎，或设置自定义引擎路径。")?;
    let model_path = if let Some(f) = model.strip_prefix("custom:") { models.join(f) } else { model_file(&models, "llm", &model).ok_or("未知模型")?.1 };
    if !model_path.exists() { return Err("所选模型尚未下载".into()); }
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("-m").arg(&model_path).arg("-p").arg(prompt).arg("-n").arg("1024").arg("--temp").arg("0.3").arg("-t").arg("4").arg("--reverse-prompt").arg("<|im_end|>");
    spawn_proc(&ai, "generate", cmd)
}
#[tauri::command]
pub fn ai_proc_poll(ai: State<AiState>) -> Result<Value, String> {
    let rt = ai.0.lock().unwrap();
    if let Some(p) = &rt.proc { let mut s = p.lock().unwrap();
        if !s.done { if let Some(ch) = s.child.as_mut() { if let Ok(Some(status)) = ch.try_wait() { s.done = true; if !status.success() && s.output.trim().is_empty() { s.error = Some(format!("引擎退出（{}）。{}", status, s.stderr_tail.trim())); } } } }
        return Ok(json!({"active": !s.done, "kind": s.kind, "progress": s.progress, "output": s.output, "done": s.done, "error": s.error}));
    }
    Ok(json!({"active": false, "done": true, "output": "", "progress": -1}))
}
#[tauri::command]
pub fn ai_proc_cancel(ai: State<AiState>) -> Result<bool, String> { let rt = ai.0.lock().unwrap(); if let Some(p) = &rt.proc { let mut s = p.lock().unwrap(); if let Some(ch) = s.child.as_mut() { let _ = ch.kill(); } s.error = Some("已取消".into()); s.done = true; } Ok(true) }
