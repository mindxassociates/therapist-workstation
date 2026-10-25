//! tw-ai-helper — offline AI component for Therapist Workstation.
//! Ships inside the downloadable AI components package (not in the app itself).
//! Protocol: one JSON object per stdout line.
//!   status    -> single status object
//!   download  -> {"type":"progress",...} * then {"type":"done"} | {"type":"error",...}
//!   transcribe/generate -> {"type":"progress","value":n} / {"type":"partial","text":..}
//!                          then {"type":"result","text":..} | {"type":"error",...}
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};

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

fn emit(v: serde_json::Value) {
    println!("{}", v.to_string());
    let _ = std::io::stdout().flush();
}
fn emit_error(msg: &str) -> ! {
    emit(serde_json::json!({"type": "error", "message": msg}));
    std::process::exit(1);
}

struct Ctx { data: PathBuf, models: PathBuf, engines: PathBuf, audio: PathBuf, pkg_engines: PathBuf, whisper_path: String, llama_path: String }
fn ctx(args: &HashMap<String, String>) -> Ctx {
    let data = PathBuf::from(args.get("data").cloned().unwrap_or_default());
    if data.as_os_str().is_empty() { emit_error("缺少 --data 参数"); }
    let models = data.join("ai-models");
    let engines = data.join("ai-engines");
    let audio = data.join("ai-audio");
    for d in [&models, &engines, &audio] { let _ = std::fs::create_dir_all(d); }
    let pkg_engines = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("engines"))).unwrap_or_default();
    Ctx { data, models, engines, audio, pkg_engines,
          whisper_path: args.get("whisper-path").cloned().unwrap_or_default(),
          llama_path: args.get("llama-path").cloned().unwrap_or_default() }
}

fn find_exe(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    if !dir.exists() { return None; }
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() { stack.push(p); } else if let Some(n) = p.file_name().and_then(|x| x.to_str()) { if names.iter().any(|w| *w == n) { return Some(p); } }
            }
        }
    }
    None
}
fn resolve_engine(c: &Ctx, which: &str) -> Option<PathBuf> {
    let names: &[&str] = if which == "whisper" {
        if cfg!(windows) { &["whisper-cli.exe", "main.exe"] } else { &["whisper-cli", "main"] }
    } else if cfg!(windows) { &["llama-cli.exe"] } else { &["llama-cli"] };
    let custom = if which == "whisper" { &c.whisper_path } else { &c.llama_path };
    if !custom.is_empty() { let pb = PathBuf::from(custom); if pb.exists() { return Some(pb); } }
    if let Some(p) = find_exe(&c.pkg_engines.join(which), names) { return Some(p); }
    if let Some(p) = find_exe(&c.engines.join(which), names) { return Some(p); }
    let mut candidates: Vec<PathBuf> = vec![];
    if cfg!(target_os = "macos") { candidates.push(PathBuf::from("/opt/homebrew/bin").join(names[0])); candidates.push(PathBuf::from("/usr/local/bin").join(names[0])); }
    if let Ok(path_var) = std::env::var("PATH") { for part in path_var.split(if cfg!(windows) { ';' } else { ':' }) { if !part.is_empty() { candidates.push(PathBuf::from(part).join(names[0])); } } }
    candidates.into_iter().find(|p| p.exists())
}
fn model_file(c: &Ctx, kind: &str, id: &str) -> Option<PathBuf> {
    if let Some(f) = id.strip_prefix("custom:") { return Some(c.models.join(f)); }
    if kind == "whisper" { WHISPER_MODELS.iter().find(|m| m.0 == id).map(|m| c.models.join(m.2)) }
    else { LLM_MODELS.iter().find(|m| m.0 == id).map(|m| c.models.join(m.2)) }
}
fn http_agent() -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new();
    if let Ok(connector) = native_tls::TlsConnector::new() { builder = builder.tls_connector(std::sync::Arc::new(connector)); }
    let proxy_url = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"].iter().find_map(|k| std::env::var(k).ok()).filter(|v| !v.is_empty());
    if let Some(u) = proxy_url { if let Ok(proxy) = ureq::Proxy::new(&u) { builder = builder.proxy(proxy); } }
    builder.build()
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

fn cmd_status(c: &Ctx) {
    let whisper = resolve_engine(c, "whisper");
    let llama = resolve_engine(c, "llama");
    let mut model_list: Vec<serde_json::Value> = vec![];
    for (id, label, file) in WHISPER_MODELS { let p = c.models.join(file); model_list.push(serde_json::json!({"id": id, "kind": "whisper", "label": label, "file": file, "downloaded": p.exists(), "bytes": p.metadata().map(|m| m.len()).unwrap_or(0)})); }
    for (id, label, file, _url) in LLM_MODELS { let p = c.models.join(file); model_list.push(serde_json::json!({"id": id, "kind": "llm", "label": label, "file": file, "downloaded": p.exists(), "bytes": p.metadata().map(|m| m.len()).unwrap_or(0)})); }
    if let Ok(rd) = std::fs::read_dir(&c.models) { for e in rd.flatten() { let n = e.file_name().to_string_lossy().to_string(); let known = WHISPER_MODELS.iter().any(|m| m.2 == n) || LLM_MODELS.iter().any(|m| m.2 == n); if !known && (n.ends_with(".bin") || n.ends_with(".gguf")) { model_list.push(serde_json::json!({"id": format!("custom:{}", n), "kind": if n.ends_with(".bin") { "whisper" } else { "llm" }, "label": format!("自定义模型 {}", n), "file": n, "downloaded": true, "bytes": e.metadata().map(|m| m.len()).unwrap_or(0)})); } } }
    emit(serde_json::json!({"whisper": {"found": whisper.is_some(), "path": whisper.map(|p| p.to_string_lossy().to_string())}, "llama": {"found": llama.is_some(), "path": llama.map(|p| p.to_string_lossy().to_string())}, "models": model_list, "modelsDir": c.models.to_string_lossy(), "enginesDir": c.engines.to_string_lossy(), "os": std::env::consts::OS}));
}

fn download_to(url: &str, dest: &Path, extract_to: Option<&Path>) {
    let part = dest.with_extension("part");
    let resp = match http_agent().get(url).call() { Ok(r) => r, Err(e) => emit_error(&format!("下载失败：{}", e)) };
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = match std::fs::File::create(&part) { Ok(f) => f, Err(e) => emit_error(&e.to_string()) };
    let mut buf = vec![0u8; 65536]; let mut received: u64 = 0; let mut last_emit: u64 = 0;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => { if file.write_all(&buf[..n]).is_err() { emit_error("写入失败"); } received += n as u64;
                if received - last_emit >= 262144 { last_emit = received; emit(serde_json::json!({"type": "progress", "received": received, "total": total})); } }
            Err(e) => { let _ = std::fs::remove_file(&part); emit_error(&format!("下载中断：{}", e)); }
        }
    }
    drop(file);
    emit(serde_json::json!({"type": "progress", "received": received, "total": total}));
    if std::fs::rename(&part, dest).is_err() { let _ = std::fs::copy(&part, dest); let _ = std::fs::remove_file(&part); }
    if let Some(dir) = extract_to {
        let f = match std::fs::File::open(dest) { Ok(f) => f, Err(e) => emit_error(&e.to_string()) };
        let mut zip = match zip::ZipArchive::new(f) { Ok(z) => z, Err(e) => emit_error(&format!("解压失败：{}", e)) };
        if let Err(e) = zip.extract(dir) { emit_error(&format!("解压失败：{}", e)); }
        let _ = std::fs::remove_file(dest);
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let mut stack = vec![dir.to_path_buf()]; while let Some(d) = stack.pop() { if let Ok(rd) = std::fs::read_dir(&d) { for e in rd.flatten() { let p = e.path(); if p.is_dir() { stack.push(p); } else { let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)); } } } } }
    }
}

fn cmd_download(c: &Ctx, what: &str) {
    let (url, dest, extract_to): (String, PathBuf, Option<PathBuf>) = if let Some(w) = what.strip_prefix("engine-") {
        let url = engine_download_url(w).unwrap_or_else(|| emit_error("当前系统暂无可自动下载的引擎包，请使用自定义引擎路径（macOS 可先通过 Homebrew 安装 whisper-cpp / llama.cpp）"));
        (url, c.engines.join(format!("{}-engine.zip", w)), Some(c.engines.join(w)))
    } else if let Some(id) = what.strip_prefix("whisper-") {
        let p = model_file(c, "whisper", id).unwrap_or_else(|| emit_error("未知模型"));
        (format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}", p.file_name().unwrap().to_string_lossy()), p, None)
    } else if let Some(id) = what.strip_prefix("llm-") {
        let m = LLM_MODELS.iter().find(|m| m.0 == id).unwrap_or_else(|| emit_error("未知模型"));
        (m.3.to_string(), c.models.join(m.2), None)
    } else { emit_error("未知下载项") };
    download_to(&url, &dest, extract_to.as_deref());
    emit(serde_json::json!({"type": "done"}));
}

fn run_engine(bin: &Path, args: &[String], stream_partials: bool) -> (String, i32, String) {
    let mut cmd = std::process::Command::new(bin);
    cmd.args(args).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).stdin(std::process::Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt as _; cmd.creation_flags(0x08000000); }
    let mut child = match cmd.spawn() { Ok(ch) => ch, Err(e) => emit_error(&format!("引擎启动失败：{}", e)) };
    let mut out_pipe = child.stdout.take().unwrap();
    let err_pipe = child.stderr.take().unwrap();
    let err_thread = std::thread::spawn(move || {
        let reader = std::io::BufReader::new(err_pipe);
        let mut tail = String::new(); let mut last_pct = -1;
        for line in reader.lines() { if let Ok(l) = line {
            if let Some(pos) = l.rfind('%') { if let Some(num) = l[..pos].rsplit(|c: char| !c.is_ascii_digit()).next() { if let Ok(v) = num.parse::<i32>() { if v != last_pct { last_pct = v; emit(serde_json::json!({"type": "progress", "value": v})); } } } }
            tail.push_str(&l); tail.push('\n'); if tail.len() > 1500 { tail = tail.chars().rev().take(1500).collect::<String>().chars().rev().collect(); }
        } }
        tail
    });
    let mut output = String::new();
    let mut buf = [0u8; 4096];
    loop { match out_pipe.read(&mut buf) { Ok(0) => break, Ok(n) => { let chunk = String::from_utf8_lossy(&buf[..n]).to_string(); if stream_partials { emit(serde_json::json!({"type": "partial", "text": chunk})); } output.push_str(&chunk); }, Err(_) => break } }
    let status = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    let tail = err_thread.join().unwrap_or_default();
    (output, status, tail)
}

fn cmd_transcribe(c: &Ctx, args: &HashMap<String, String>) {
    let bin = resolve_engine(c, "whisper").unwrap_or_else(|| emit_error("未找到转写引擎（whisper-cli）。请先下载引擎，或设置自定义引擎路径。"));
    let model_id = args.get("model").cloned().unwrap_or_default();
    let model_path = model_file(c, "whisper", &model_id).unwrap_or_else(|| emit_error("未知模型"));
    if !model_path.exists() { emit_error("所选模型尚未下载"); }
    let audio = args.get("audio").cloned().unwrap_or_default();
    let lang = args.get("lang").cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| "auto".into());
    let a: Vec<String> = vec!["-m".into(), model_path.to_string_lossy().into(), "-f".into(), audio, "-l".into(), lang, "--no-timestamps".into(), "-pp".into(), "-t".into(), "4".into()];
    let (out, code, tail) = run_engine(&bin, &a, false);
    if code != 0 && out.trim().is_empty() { emit_error(&format!("转写引擎退出（{}）。{}", code, tail.trim())); }
    emit(serde_json::json!({"type": "result", "text": out}));
}
fn cmd_generate(c: &Ctx, args: &HashMap<String, String>) {
    let bin = resolve_engine(c, "llama").unwrap_or_else(|| emit_error("未找到笔记生成引擎（llama-cli）。请先下载引擎，或设置自定义引擎路径。"));
    let model_id = args.get("model").cloned().unwrap_or_default();
    let model_path = model_file(c, "llm", &model_id).unwrap_or_else(|| emit_error("未知模型"));
    if !model_path.exists() { emit_error("所选模型尚未下载"); }
    let prompt_file = args.get("prompt-file").cloned().unwrap_or_default();
    let prompt = std::fs::read_to_string(&prompt_file).unwrap_or_else(|_| emit_error("提示词文件读取失败"));
    let a: Vec<String> = vec!["-m".into(), model_path.to_string_lossy().into(), "-p".into(), prompt, "-n".into(), "1024".into(), "--temp".into(), "0.3".into(), "-t".into(), "4".into(), "--reverse-prompt".into(), "<|im_end|>".into()];
    let (out, code, tail) = run_engine(&bin, &a, true);
    if code != 0 && out.trim().is_empty() { emit_error(&format!("生成引擎退出（{}）。{}", code, tail.trim())); }
    emit(serde_json::json!({"type": "result", "text": out}));
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() < 2 { emit_error("缺少命令（status/download/transcribe/generate）"); }
    let command = argv[1].clone();
    let mut args: HashMap<String, String> = HashMap::new();
    let mut i = 2;
    while i + 1 < argv.len() + 0 && i + 1 <= argv.len() - 1 { if argv[i].starts_with("--") { args.insert(argv[i][2..].to_string(), argv[i + 1].clone()); i += 2; } else { i += 1; } }
    let c = ctx(&args);
    match command.as_str() {
        "status" => cmd_status(&c),
        "download" => cmd_download(&c, &args.get("what").cloned().unwrap_or_default()),
        "transcribe" => cmd_transcribe(&c, &args),
        "generate" => cmd_generate(&c, &args),
        _ => emit_error("未知命令"),
    }
}
