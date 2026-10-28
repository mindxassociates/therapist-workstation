//! Optional AI components: the app ships without any AI code paths active.
//! Installed (non-portable) copies can download the AI component package
//! (tw-ai-helper + engines) for the matching app version from the project's
//! GitHub Releases; every AI operation is then relayed to that helper
//! process through a JSON-lines protocol. Portable copies never expose AI.

use super::*;

pub struct CompState(pub Mutex<CompRuntime>);
#[derive(Default)]
pub struct CompRuntime {
    install: Option<Arc<Mutex<InstallShared>>>,
    proc: Option<Arc<Mutex<ProcShared>>>,
    audio: HashMap<String, PathBuf>,
}
#[derive(Default, Clone)]
struct InstallShared { received: u64, total: u64, done: bool, error: Option<String> }
#[derive(Default)]
struct ProcShared { kind: String, label: String, progress: i32, received: u64, total: u64, output: String, stderr_tail: String, done: bool, error: Option<String>, child: Option<std::process::Child> }

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

fn app_paths(state: &State<AppState>) -> Result<(PathBuf, bool), String> {
    let rt = state.0.lock().unwrap();
    require_user(&rt)?;
    let p = rt.paths.as_ref().ok_or("数据目录不可用")?;
    let portable = p.data.parent().map(|x| x.join("portable.mode").exists()).unwrap_or(false);
    Ok((p.data.clone(), portable))
}
fn comp_dir(data: &Path) -> PathBuf { data.join("ai-components").join(APP_VERSION) }
fn helper_file(data: &Path) -> PathBuf { comp_dir(data).join(if cfg!(windows) { "tw-ai-helper.exe" } else { "tw-ai-helper" }) }
fn ai_dirs(state: &State<AppState>) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let (data, _p) = app_paths(state)?;
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
fn helper_cmd(state: &State<AppState>, command: &str) -> Result<std::process::Command, String> {
    let (data, _p) = app_paths(state)?;
    let helper = helper_file(&data);
    if !helper.exists() { return Err("智能记录组件尚未安装".into()); }
    let mut cmd = std::process::Command::new(&helper);
    cmd.arg(command).arg("--data").arg(&data);
    if let Some(p) = pref_value(state, "aiWhisperPath") { cmd.arg("--whisper-path").arg(p); }
    if let Some(p) = pref_value(state, "aiLlamaPath") { cmd.arg("--llama-path").arg(p); }
    #[cfg(windows)] { use std::os::windows::process::CommandExt as _; cmd.creation_flags(0x08000000); }
    Ok(cmd)
}

#[tauri::command]
pub fn ai_comp_status(state: State<AppState>) -> Result<Value, String> {
    let (data, portable) = app_paths(&state)?;
    Ok(json!({"portable": portable, "installed": helper_file(&data).exists(), "version": APP_VERSION, "os": std::env::consts::OS}))
}

fn comp_http_agent() -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new();
    if let Ok(connector) = native_tls::TlsConnector::new() { builder = builder.tls_connector(std::sync::Arc::new(connector)); }
    let proxy_url = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"].iter().find_map(|k| std::env::var(k).ok()).filter(|v| !v.is_empty());
    if let Some(u) = proxy_url { if let Ok(proxy) = ureq::Proxy::new(&u) { builder = builder.proxy(proxy); } }
    builder.build()
}

#[tauri::command]
pub fn ai_comp_install(state: State<AppState>, comp: State<CompState>) -> Result<bool, String> {
    let (data, portable) = app_paths(&state)?;
    if portable { return Err("便携版不支持安装智能记录组件".into()); }
    let os = std::env::consts::OS;
    if os != "windows" && os != "macos" { return Err("当前系统暂无组件包".into()); }
    let url = format!("https://github.com/mindxassociates/therapist-workstation/releases/download/v{0}/ai-components-v{0}-{1}.zip", APP_VERSION, os);
    let shared = Arc::new(Mutex::new(InstallShared::default()));
    { let mut rt = comp.0.lock().unwrap(); if let Some(d) = &rt.install { if !d.lock().unwrap().done { return Err("组件下载正在进行".into()); } } rt.install = Some(shared.clone()); }
    let dest_dir = comp_dir(&data);
    std::thread::spawn(move || {
        let fail = |s: &Arc<Mutex<InstallShared>>, msg: String| { let mut g = s.lock().unwrap(); g.error = Some(msg); g.done = true; };
        let zip_path = data.join("ai-components").join(format!("ai-components-v{}-{}.zip", APP_VERSION, os));
        if let Some(parent) = zip_path.parent() { let _ = fs::create_dir_all(parent); }
        let resp = match comp_http_agent().get(&url).call() { Ok(r) => r, Err(e) => { fail(&shared, format!("组件下载失败（{}）。请确认本版本已发布对应的组件包，或检查网络。", e)); return; } };
        let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
        { shared.lock().unwrap().total = total; }
        let mut reader = resp.into_reader();
        let mut file = match fs::File::create(&zip_path) { Ok(f) => f, Err(e) => { fail(&shared, e.to_string()); return; } };
        let mut buf = vec![0u8; 65536]; let mut received: u64 = 0;
        loop {
            match reader.read(&mut buf) { Ok(0) => break, Ok(n) => { use std::io::Write as _; if file.write_all(&buf[..n]).is_err() { fail(&shared, "写入失败".into()); return; } received += n as u64; shared.lock().unwrap().received = received; }, Err(e) => { fail(&shared, format!("下载中断：{}", e)); return; } }
        }
        drop(file);
        let _ = fs::remove_dir_all(&dest_dir);
        if let Err(e) = fs::create_dir_all(&dest_dir) { fail(&shared, e.to_string()); return; }
        let f = match fs::File::open(&zip_path) { Ok(f) => f, Err(e) => { fail(&shared, e.to_string()); return; } };
        let mut zip = match zip::ZipArchive::new(f) { Ok(z) => z, Err(e) => { fail(&shared, format!("组件包解压失败：{}", e)); return; } };
        if let Err(e) = zip.extract(&dest_dir) { fail(&shared, format!("组件包解压失败：{}", e)); return; }
        let _ = fs::remove_file(&zip_path);
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let helper = dest_dir.join("tw-ai-helper"); if helper.exists() { let _ = fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)); } let mut stack = vec![dest_dir.join("engines")]; while let Some(d) = stack.pop() { if let Ok(rd) = fs::read_dir(&d) { for e in rd.flatten() { let p = e.path(); if p.is_dir() { stack.push(p); } else { let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o755)); } } } } }
        if !helper_file(&data).exists() { fail(&shared, "组件包内容不完整（缺少组件程序），请重新下载".into()); return; }
        shared.lock().unwrap().done = true;
    });
    Ok(true)
}
#[tauri::command]
pub fn ai_comp_poll(comp: State<CompState>) -> Result<Value, String> {
    let rt = comp.0.lock().unwrap();
    if let Some(d) = &rt.install { let s = d.lock().unwrap(); return Ok(json!({"active": !s.done, "received": s.received, "total": s.total, "done": s.done, "error": s.error})); }
    Ok(json!({"active": false, "received": 0, "total": 0, "done": false, "error": null}))
}
#[tauri::command]
pub fn ai_comp_remove(state: State<AppState>) -> Result<bool, String> {
    let (data, _p) = app_paths(&state)?;
    let _ = fs::remove_dir_all(comp_dir(&data));
    Ok(true)
}

// ---- AI operations, relayed to the helper process (JSON-lines protocol) ----
fn spawn_helper(comp: &State<CompState>, kind: &str, label: &str, cmd: std::process::Command) -> Result<bool, String> {
    use std::io::Read as _;
    let mut cmd = cmd;
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).stdin(std::process::Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("组件启动失败：{}", e))?;
    let out = child.stdout.take(); let err = child.stderr.take();
    let shared = Arc::new(Mutex::new(ProcShared { kind: kind.to_string(), label: label.to_string(), progress: -1, ..Default::default() }));
    shared.lock().unwrap().child = Some(child);
    if let Some(so) = out { let sh = shared.clone(); std::thread::spawn(move || { use std::io::BufRead as _; let reader = std::io::BufReader::new(so); for line in reader.lines() { if let Ok(l) = line { if let Ok(v) = serde_json::from_str::<Value>(&l) { let mut s = sh.lock().unwrap(); match v.get("type").and_then(|t| t.as_str()) { Some("progress") => { if let Some(p) = v.get("value").and_then(|x| x.as_i64()) { s.progress = p as i32; } if let Some(r) = v.get("received").and_then(|x| x.as_u64()) { s.received = r; } if let Some(t) = v.get("total").and_then(|x| x.as_u64()) { s.total = t; } }, Some("partial") => { if let Some(t) = v.get("text").and_then(|x| x.as_str()) { s.output.push_str(t); } }, Some("result") => { if let Some(t) = v.get("text").and_then(|x| x.as_str()) { s.output = t.to_string(); } }, Some("error") => { if let Some(m) = v.get("message").and_then(|x| x.as_str()) { s.error = Some(m.to_string()); } }, _ => {} } } } } }); }
    if let Some(se) = err { let sh = shared.clone(); std::thread::spawn(move || { let mut b = [0u8; 2048]; let mut se = se; loop { match se.read(&mut b) { Ok(0) => break, Ok(n) => { let mut s = sh.lock().unwrap(); let tail = format!("{}{}", s.stderr_tail, String::from_utf8_lossy(&b[..n])); s.stderr_tail = tail.chars().rev().take(1200).collect::<String>().chars().rev().collect(); }, Err(_) => break } } }); }
    { let mut rt = comp.0.lock().unwrap(); rt.proc = Some(shared); }
    Ok(true)
}
fn proc_snapshot(comp: &State<CompState>) -> Option<Value> {
    let rt = comp.0.lock().unwrap();
    rt.proc.as_ref().map(|p| { let mut s = p.lock().unwrap();
        if !s.done { if let Some(ch) = s.child.as_mut() { if let Ok(Some(status)) = ch.try_wait() { s.done = true; if !status.success() && s.error.is_none() && s.output.trim().is_empty() { s.error = Some(format!("组件进程退出（{}）。{}", status, s.stderr_tail.trim())); } } } }
        json!({"active": !s.done, "kind": s.kind, "label": s.label, "progress": s.progress, "received": s.received, "total": s.total, "output": s.output, "done": s.done, "error": s.error})
    })
}

#[tauri::command]
pub fn ai_status(state: State<AppState>, comp: State<CompState>) -> Result<Value, String> {
    let mut cmd = helper_cmd(&state, "status")?;
    let out = cmd.output().map_err(|e| format!("组件启动失败：{}", e))?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let line = text.lines().last().ok_or("组件未返回状态")?;
    let mut v: Value = serde_json::from_str(line).map_err(|_| "组件状态解析失败".to_string())?;
    let snap = proc_snapshot(&comp);
    let download = snap.as_ref().filter(|s| s.get("kind").and_then(|k| k.as_str()) == Some("download")).map(|s| json!({"label": s.get("label"), "received": s.get("received"), "total": s.get("total"), "done": s.get("done"), "error": s.get("error")}));
    let proc = snap.as_ref().map(|s| json!({"kind": s.get("kind"), "done": s.get("done")}));
    if let Some(obj) = v.as_object_mut() { obj.insert("installed".into(), json!(true)); obj.insert("download".into(), download.unwrap_or(Value::Null)); obj.insert("proc".into(), proc.unwrap_or(Value::Null)); }
    Ok(v)
}
#[tauri::command]
pub fn ai_download(state: State<AppState>, comp: State<CompState>, what: String) -> Result<bool, String> {
    { let rt = comp.0.lock().unwrap(); if let Some(p) = &rt.proc { let s = p.lock().unwrap(); if !s.done && s.kind == "download" { return Err("已有下载正在进行".into()); } } }
    let mut cmd = helper_cmd(&state, "download")?;
    cmd.arg("--what").arg(&what);
    spawn_helper(&comp, "download", &what, cmd)
}
#[tauri::command]
pub fn ai_download_cancel(comp: State<CompState>) -> Result<bool, String> { ai_proc_cancel(comp) }
#[tauri::command]
pub fn transcribe_start(state: State<AppState>, comp: State<CompState>, audio_path: String, model: String, lang: String) -> Result<bool, String> {
    let mut cmd = helper_cmd(&state, "transcribe")?;
    cmd.arg("--audio").arg(&audio_path).arg("--model").arg(&model).arg("--lang").arg(if lang.is_empty() { "auto".to_string() } else { lang });
    spawn_helper(&comp, "transcribe", "", cmd)
}
#[tauri::command]
pub fn generate_start(state: State<AppState>, comp: State<CompState>, model: String, prompt: String) -> Result<bool, String> {
    let (_m, _e, audio) = ai_dirs(&state)?;
    let prompt_file = audio.join(format!("prompt-{}.txt", Uuid::new_v4()));
    fs::write(&prompt_file, &prompt).map_err(|e| e.to_string())?;
    let mut cmd = helper_cmd(&state, "generate")?;
    cmd.arg("--model").arg(&model).arg("--prompt-file").arg(&prompt_file);
    spawn_helper(&comp, "generate", "", cmd)
}
#[tauri::command]
pub fn ai_proc_poll(comp: State<CompState>) -> Result<Value, String> {
    match proc_snapshot(&comp) {
        Some(mut v) => { if let Some(o) = v.as_object_mut() { o.remove("received"); o.remove("total"); o.remove("label"); } Ok(v) }
        None => Ok(json!({"active": false, "done": true, "output": "", "progress": -1, "error": null})),
    }
}
#[tauri::command]
pub fn ai_proc_cancel(comp: State<CompState>) -> Result<bool, String> { let rt = comp.0.lock().unwrap(); if let Some(p) = &rt.proc { let mut s = p.lock().unwrap(); if let Some(ch) = s.child.as_mut() { let _ = ch.kill(); } s.error = Some("已取消".into()); s.done = true; } Ok(true) }
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
// Recording temp files (chunked upload from the webview)
#[tauri::command]
pub fn audio_begin(state: State<AppState>, comp: State<CompState>) -> Result<Value, String> {
    let (_m, _e, audio) = ai_dirs(&state)?;
    let id = Uuid::new_v4().to_string(); let path = audio.join(format!("{}.wav", id));
    fs::write(&path, []).map_err(|e| e.to_string())?;
    comp.0.lock().unwrap().audio.insert(id.clone(), path.clone());
    Ok(json!({"id": id, "path": path.to_string_lossy()}))
}
#[tauri::command]
pub fn audio_append(comp: State<CompState>, id: String, data: String) -> Result<bool, String> {
    use base64::Engine as _;
    let path = { let rt = comp.0.lock().unwrap(); rt.audio.get(&id).cloned().ok_or("录音会话不存在")? };
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new().append(true).open(&path).map_err(|e| e.to_string())?;
    use std::io::Write as _; f.write_all(&bytes).map_err(|e| e.to_string())?; Ok(true)
}
#[tauri::command]
pub fn audio_finish(comp: State<CompState>, id: String) -> Result<Value, String> {
    let rt = comp.0.lock().unwrap(); let path = rt.audio.get(&id).cloned().ok_or("录音会话不存在")?;
    Ok(json!({"path": path.to_string_lossy(), "bytes": path.metadata().map(|m| m.len()).unwrap_or(0)}))
}
#[tauri::command]
pub fn audio_discard(state: State<AppState>, path: String) -> Result<bool, String> {
    let (_m, _e, audio) = ai_dirs(&state)?;
    let p = PathBuf::from(&path); if p.starts_with(&audio) { let _ = fs::remove_file(p); } Ok(true)
}
