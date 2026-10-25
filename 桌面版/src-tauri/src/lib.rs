use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use chrono::Utc;
use hmac::{Hmac, Mac};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use scrypt::{scrypt, Params as ScryptParams};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, io::Read as _, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

mod components;

#[derive(Default)]
struct Runtime {
    db: Option<Connection>,
    db_key: Option<[u8; 32]>,
    user: Option<UserSession>,
    paths: Option<AppPaths>,
    failures: HashMap<String, (u32, i64)>,
}
struct AppState(Mutex<Runtime>);

#[derive(Clone)]
struct AppPaths { data: PathBuf, backups: PathBuf, db: PathBuf, access: PathBuf }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct UserSession { id:String, username:String, display_name:String, role:String }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct AuthStatus { needs_setup: bool, authenticated: bool, user: Option<UserSession> }
#[derive(Serialize)]
struct OpResult { ok: bool, #[serde(skip_serializing_if="Option::is_none")] error: Option<String>, #[serde(skip_serializing_if="Option::is_none")] user: Option<UserSession> }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct SetupInput { username:String, display_name:String, password:String }
#[derive(Deserialize)]
struct LoginInput { username:String, password:String }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct ChangePasswordInput { current_password:String, new_password:String }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct CreateUserInput { username:String, display_name:String, role:String, password:String }
#[derive(Deserialize)]
struct ActiveInput { id:String, active:bool }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct AuditEventInput { action:String, object_type:Option<String>, object_id:Option<String>, detail:Option<String> }
#[derive(Serialize, Deserialize, Default)]
struct AccessFile { version:u32, users:Vec<AccessUser> }
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all="camelCase")]
struct AccessUser { id:String, username:String, display_name:String, role:String, active:bool, salt:String, verifier:String, wrapped_key:WrappedKey }
#[derive(Serialize, Deserialize, Clone)]
struct WrappedKey { nonce:String, data:String }

fn now() -> String { Utc::now().to_rfc3339() }
fn now_ms() -> i64 { Utc::now().timestamp_millis() }
fn random32() -> [u8;32] { let mut b=[0u8;32]; rand::rng().fill_bytes(&mut b); b }
fn random16() -> [u8;16] { let mut b=[0u8;16]; rand::rng().fill_bytes(&mut b); b }
fn derive(password:&str, salt:&[u8]) -> Result<[u8;32],String> { let mut out=[0u8;32]; let p=ScryptParams::new(15,8,1,32).map_err(|e|e.to_string())?; scrypt(password.as_bytes(),salt,&p,&mut out).map_err(|e|e.to_string())?; Ok(out) }
fn verifier(password:&str,salt:&[u8])->Result<String,String>{let k=derive(password,salt)?;let mut mac=<HmacSha256 as Mac>::new_from_slice(&k).map_err(|e|e.to_string())?;mac.update(b"therapist-workstation-access-v2");Ok(hex::encode(mac.finalize().into_bytes()))}
fn wrap_key(db_key:&[u8;32],password:&str,salt:&[u8])->Result<WrappedKey,String>{let key=derive(password,salt)?;let cipher=Aes256Gcm::new_from_slice(&key).map_err(|e|e.to_string())?;let mut n=[0u8;12];rand::rng().fill_bytes(&mut n);let data=cipher.encrypt(Nonce::from_slice(&n),db_key.as_ref()).map_err(|_|"无法保护数据库密钥".to_string())?;Ok(WrappedKey{nonce:hex::encode(n),data:hex::encode(data)})}
fn unwrap_key(w:&WrappedKey,password:&str,salt:&[u8])->Result<[u8;32],String>{let key=derive(password,salt)?;let cipher=Aes256Gcm::new_from_slice(&key).map_err(|e|e.to_string())?;let n=hex::decode(&w.nonce).map_err(|_|"凭据损坏".to_string())?;let data=hex::decode(&w.data).map_err(|_|"凭据损坏".to_string())?;let plain=cipher.decrypt(Nonce::from_slice(&n),data.as_ref()).map_err(|_|"用户名或密码不正确。".to_string())?;plain.try_into().map_err(|_|"数据库密钥长度无效".to_string())}
fn password_hash(password:&str,salt:&[u8])->Result<String,String>{Ok(hex::encode(derive(password,salt)?))}
fn ct_eq_hex(a:&str,b:&str)->bool{match(hex::decode(a),hex::decode(b)){(Ok(x),Ok(y)) if x.len()==y.len()=>x.ct_eq(&y).into(),_=>false}}

fn portable_base(exe:&Path)->Option<PathBuf>{
    // A "portable.mode" marker file switches the app to portable mode:
    // all data lives in Data/ + Backups/ folders next to the marker.
    // Windows / loose binary: the marker sits beside the .exe.
    // macOS: the marker sits beside the .app bundle (the binary itself
    // lives in App.app/Contents/MacOS and the bundle must stay read-only
    // to keep its code signature valid).
    let exe_dir=exe.parent()?.to_path_buf();
    if exe_dir.join("portable.mode").exists(){return Some(exe_dir)}
    if exe_dir.ends_with("MacOS"){
        if let Some(folder)=exe_dir.parent().and_then(|c|c.parent()).and_then(|b|b.parent()){
            if folder.join("portable.mode").exists(){return Some(folder.to_path_buf())}
        }
    }
    None
}
fn make_paths(base:PathBuf)->Result<AppPaths,String>{
    let data=base.join("Data");let backups=base.join("Backups");
    fs::create_dir_all(&data).map_err(|e|e.to_string())?;fs::create_dir_all(&backups).map_err(|e|e.to_string())?;
    Ok(AppPaths{db:data.join("workspace.db"),access:data.join("access.json"),data,backups})
}
fn app_paths(app:&AppHandle)->Result<AppPaths,String>{
    let exe=std::env::current_exe().map_err(|e|e.to_string())?;
    let exe_dir=exe.parent().unwrap_or(Path::new(".")).to_path_buf();
    let portable=portable_base(&exe).or_else(||if std::env::var("THERAPIST_WORKSTATION_PORTABLE").ok().as_deref()==Some("1"){Some(exe_dir.clone())}else{None});
    if let Some(base)=portable{
        // If the portable location turns out not to be writable
        // (e.g. a read-only USB stick), fall back to the standard
        // per-user data directory instead of failing to start.
        if let Ok(paths)=make_paths(base){return Ok(paths)}
    }
    let base=app.path().app_local_data_dir().map_err(|e|e.to_string())?;
    make_paths(base)
}
fn read_access(p:&Path)->AccessFile{fs::read_to_string(p).ok().and_then(|s|serde_json::from_str(&s).ok()).unwrap_or(AccessFile{version:2,users:vec![]})}
fn write_access(p:&Path,a:&AccessFile)->Result<(),String>{let tmp=p.with_extension("json.tmp");fs::write(&tmp,serde_json::to_vec_pretty(a).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;fs::rename(tmp,p).map_err(|e|e.to_string())}
fn open_db(path:&Path,key:&[u8;32])->Result<Connection,String>{let c=Connection::open(path).map_err(|e|e.to_string())?;c.pragma_update(None,"key",format!("x'{}'",hex::encode(key))).map_err(|e|format!("数据库解锁失败：{e}"))?;c.query_row("SELECT count(*) FROM sqlite_master",[],|r|r.get::<_,i64>(0)).map_err(|_|"数据库密码或文件无效。".to_string())?;create_schema(&c)?;Ok(c)}
fn create_schema(c:&Connection)->Result<(),String>{c.execute_batch(r#"
PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,dob TEXT,gender TEXT,status TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,client_id TEXT,date TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS appointments(id TEXT PRIMARY KEY,client_id TEXT,date TEXT,time TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,client_id TEXT,status TEXT,due TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,client_id TEXT,date TEXT,status TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY,client_id TEXT,status TEXT,due TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quick_notes(id TEXT PRIMARY KEY,client_id TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_templates(id TEXT PRIMARY KEY,name TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS referrals(id TEXT PRIMARY KEY,name TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assessments(id TEXT PRIMARY KEY,client_id TEXT,date TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS waitlist(id TEXT PRIMARY KEY,name TEXT,status TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recent_views(id TEXT PRIMARY KEY,client_id TEXT,viewed_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS treatment_plans(client_id TEXT PRIMARY KEY,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT NOT NULL,user_id TEXT,username TEXT,action TEXT NOT NULL,object_type TEXT,object_id TEXT,result TEXT NOT NULL,detail TEXT,prev_hash TEXT NOT NULL,entry_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
"#).map_err(|e|e.to_string())?;Ok(())}
fn require_user(rt:&Runtime)->Result<&UserSession,String>{rt.user.as_ref().ok_or_else(||"工作台已锁定，请重新登录。".to_string())}
fn require_admin(rt:&Runtime)->Result<&UserSession,String>{let u=require_user(rt)?;if u.role!="管理员"{return Err("仅管理员可以执行此操作。".into())}Ok(u)}
fn audit_key(rt:&Runtime)->Result<[u8;32],String>{let k=rt.db_key.ok_or("数据库未解锁")?;let mut h=Sha256::new();h.update(b"audit-v2|");h.update(k);Ok(h.finalize().into())}
fn audit(rt:&Runtime,action:&str,typ:&str,id:&str,result:&str,detail:&str)->Result<(),String>{let db=rt.db.as_ref().ok_or("数据库未解锁")?;let prev:String=db.query_row("SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?.unwrap_or_else(||"GENESIS".into());let ts=now();let (uid,un)=rt.user.as_ref().map(|u|(u.id.clone(),u.username.clone())).unwrap_or((String::new(),"系统".into()));let payload=format!("{}|{}|{}|{}|{}|{}|{}|{}|{}",ts,uid,un,action,typ,id,result,detail,prev);let mut mac=<HmacSha256 as Mac>::new_from_slice(&audit_key(rt)?).map_err(|e|e.to_string())?;mac.update(payload.as_bytes());let hash=hex::encode(mac.finalize().into_bytes());db.execute("INSERT INTO audit_log(ts,user_id,username,action,object_type,object_id,result,detail,prev_hash,entry_hash) VALUES(?,?,?,?,?,?,?,?,?,?)",params![ts,uid,un,action,typ,id,result,detail.chars().take(1000).collect::<String>(),prev,hash]).map_err(|e|e.to_string())?;Ok(())}
fn all_json(db:&Connection,table:&str)->Result<Vec<Value>,String>{let mut st=db.prepare(&format!("SELECT json FROM {table}")).map_err(|e|e.to_string())?;let rows=st.query_map([],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;Ok(rows.filter_map(|x|x.ok()).filter_map(|x|serde_json::from_str(&x).ok()).collect())}
fn workspace(db:&Connection)->Result<Value,String>{let settings:String=db.query_row("SELECT json FROM settings WHERE id=1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?.unwrap_or("{}".into());Ok(json!({"clients":all_json(db,"clients")?,"sessions":all_json(db,"sessions")?,"events":all_json(db,"appointments")?,"tasks":all_json(db,"tasks")?,"finance":all_json(db,"payments")?,"goals":all_json(db,"goals")?,"quickNotes":all_json(db,"quick_notes")?,"templates":all_json(db,"session_templates")?,"referrals":all_json(db,"referrals")?,"assessments":all_json(db,"assessments")?,"waitlist":all_json(db,"waitlist")?,"recent":all_json(db,"recent_views")?,"settings":serde_json::from_str::<Value>(&settings).unwrap_or(json!({}))}))}
fn insert_json(tx:&rusqlite::Transaction<'_>,table:&str,o:&Value,extra:&[(&str,Value)])->Result<(),String>{let id=o.get("id").and_then(Value::as_str).unwrap_or("");let mut cols=vec!["id".to_string()];let mut vals=vec![Value::String(id.into())];for(k,v)in extra{cols.push((*k).into());vals.push(v.clone())}cols.push("updated_at".into());vals.push(Value::String(now()));cols.push("json".into());vals.push(Value::String(serde_json::to_string(o).map_err(|e|e.to_string())?));let sql=format!("INSERT INTO {table}({}) VALUES({})",cols.join(","),vec!["?";cols.len()].join(","));let params:Vec<rusqlite::types::Value>=vals.into_iter().map(|v|match v{Value::Null=>rusqlite::types::Value::Null,Value::String(s)=>rusqlite::types::Value::Text(s),_=>rusqlite::types::Value::Text(v.to_string())}).collect();tx.execute(&sql,rusqlite::params_from_iter(params)).map_err(|e|e.to_string())?;Ok(())}
fn replace_workspace(db:&mut Connection,x:&Value)->Result<(),String>{let tx=db.transaction().map_err(|e|e.to_string())?;tx.execute_batch("DELETE FROM sessions;DELETE FROM appointments;DELETE FROM tasks;DELETE FROM payments;DELETE FROM goals;DELETE FROM quick_notes;DELETE FROM session_templates;DELETE FROM referrals;DELETE FROM assessments;DELETE FROM waitlist;DELETE FROM recent_views;DELETE FROM treatment_plans;DELETE FROM clients;DELETE FROM settings;").map_err(|e|e.to_string())?;for o in x["clients"].as_array().unwrap_or(&vec![]){insert_json(&tx,"clients",o,&[("name",o["name"].clone()),("dob",o["dob"].clone()),("gender",o["gender"].clone()),("status",o["status"].clone())])?;if let Some(plan)=o.get("plan"){if plan.as_object().map(|x|!x.is_empty()).unwrap_or(false){tx.execute("INSERT INTO treatment_plans(client_id,updated_at,json) VALUES(?,?,?)",params![o["id"].as_str().unwrap_or(""),now(),plan.to_string()]).map_err(|e|e.to_string())?;}}}for(key,table,extras)in[("sessions","sessions",vec!["client_id","date"]),("events","appointments",vec!["client_id","date","time"]),("tasks","tasks",vec!["client_id","status","due"]),("finance","payments",vec!["client_id","date","status"]),("goals","goals",vec!["client_id","status","due"]),("quickNotes","quick_notes",vec!["client_id"]),("templates","session_templates",vec!["name"]),("referrals","referrals",vec!["name"]),("assessments","assessments",vec!["client_id","date"]),("waitlist","waitlist",vec!["name","status"]),("recent","recent_views",vec!["client_id","viewed_at"]) ]{if let Some(a)=x[key].as_array(){for o in a{let ex:Vec<(&str,Value)>=extras.iter().map(|k|{let js=match *k{"client_id"=>o.get("clientId").cloned().filter(|v|v.as_str().map(|s|!s.is_empty()).unwrap_or(false)).unwrap_or(Value::Null),"viewed_at"=>o.get("time").cloned().unwrap_or(Value::Null),_=>o.get(k.trim_end_matches("_id")).cloned().or_else(||o.get(*k).cloned()).unwrap_or(Value::Null)};(*k,js)}).collect();insert_json(&tx,table,o,&ex)?}}}tx.execute("INSERT INTO settings(id,json,updated_at) VALUES(1,?,?)",params![x.get("settings").unwrap_or(&json!({})).to_string(),now()]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())}


fn daily_auto_backup(p:&AppPaths,db:&Connection,key:&[u8;32]){
    // Once per calendar day (UTC date in the file name), keep the newest 30 auto backups.
    let today=Utc::now().with_timezone(&chrono::FixedOffset::east_opt(8*3600).unwrap()).format("%Y-%m-%d").to_string();
    let file=p.backups.join(format!("workspace_{today}_auto.db"));
    if file.exists(){return}
    if db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").is_err(){return}
    if fs::copy(&p.db,&file).is_err(){return}
    let verified=open_db(&file,key).and_then(|chk|chk.query_row("PRAGMA integrity_check",[],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())).map(|s|s.eq_ignore_ascii_case("ok")).unwrap_or(false);
    if !verified{let _=fs::remove_file(&file);return}
    if let Ok(rd)=fs::read_dir(&p.backups){
        let mut autos:Vec<PathBuf>=rd.filter_map(|e|e.ok()).map(|e|e.path()).filter(|x|x.file_name().and_then(|n|n.to_str()).map(|n|n.starts_with("workspace_")&&n.ends_with("_auto.db")).unwrap_or(false)).collect();
        autos.sort();
        while autos.len()>30{let old=autos.remove(0);let _=fs::remove_file(old);}
    }
}
#[tauri::command] fn startup_status(app:AppHandle,state:State<AppState>)->Result<AuthStatus,String>{let mut rt=state.0.lock().unwrap();let p=app_paths(&app)?;let a=read_access(&p.access);let needs=!p.db.exists()||fs::metadata(&p.db).map(|m|m.len()==0).unwrap_or(true)||a.users.is_empty();rt.paths=Some(p);Ok(AuthStatus{needs_setup:needs,authenticated:false,user:None})}
#[tauri::command] fn startup_setup(app:AppHandle,state:State<AppState>,input:SetupInput)->Result<OpResult,String>{if input.username.trim().len()<2||input.password.len()<10{return Ok(OpResult{ok:false,error:Some("用户名至少 2 个字符，密码至少 10 位。".into()),user:None})}let p=app_paths(&app)?;if p.db.exists()&&fs::metadata(&p.db).map(|m|m.len()>0).unwrap_or(false){return Ok(OpResult{ok:false,error:Some("检测到已有数据库，不能覆盖。".into()),user:None})}let key=random32();let db=open_db(&p.db,&key)?;let salt=random16();let id=Uuid::new_v4().to_string();let ph=password_hash(&input.password,&salt)?;db.execute("INSERT INTO users(id,username,display_name,password_hash,salt,role,active,created_at,updated_at) VALUES(?,?,?,?,?,'管理员',1,?,?)",params![id,input.username.trim(),if input.display_name.trim().is_empty(){input.username.trim()}else{input.display_name.trim()},ph,hex::encode(salt),now(),now()]).map_err(|e|e.to_string())?;let user=UserSession{id:id.clone(),username:input.username.trim().into(),display_name:if input.display_name.trim().is_empty(){input.username.trim().into()}else{input.display_name.trim().into()},role:"管理员".into()};let au=AccessUser{id:id.clone(),username:user.username.clone(),display_name:user.display_name.clone(),role:user.role.clone(),active:true,salt:hex::encode(salt),verifier:verifier(&input.password,&salt)?,wrapped_key:wrap_key(&key,&input.password,&salt)?};write_access(&p.access,&AccessFile{version:2,users:vec![au]})?;let mut rt=state.0.lock().unwrap();rt.db=Some(db);rt.db_key=Some(key);rt.user=Some(user.clone());rt.paths=Some(p);audit(&rt,"创建用户","用户",&id,"成功","首次管理员账户")?;Ok(OpResult{ok:true,error:None,user:Some(user)})}
#[tauri::command] fn startup_login(app:AppHandle,state:State<AppState>,input:LoginInput)->Result<OpResult,String>{let p=app_paths(&app)?;let a=read_access(&p.access);let mut rt=state.0.lock().unwrap();let f=rt.failures.get(&input.username).cloned().unwrap_or((0,0));if now_ms()<f.1{return Ok(OpResult{ok:false,error:Some("登录尝试过多，请稍后再试。".into()),user:None})}let au=match a.users.iter().find(|u|u.username==input.username&&u.active){Some(x)=>x.clone(),None=>return Ok(OpResult{ok:false,error:Some("用户名或密码不正确。".into()),user:None})};let salt=hex::decode(&au.salt).map_err(|_|"访问凭据损坏".to_string())?;if !ct_eq_hex(&verifier(&input.password,&salt)?,&au.verifier){let n=f.0+1;rt.failures.insert(input.username.clone(),if n>=5{(0,now_ms()+300000)}else{(n,0)});return Ok(OpResult{ok:false,error:Some("用户名或密码不正确。".into()),user:None})}let key=unwrap_key(&au.wrapped_key,&input.password,&salt)?;let db=open_db(&p.db,&key)?;let row:(String,String,String,String,i64,String)=db.query_row("SELECT id,username,display_name,role,active,password_hash FROM users WHERE id=?",[&au.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(|_|"账户验证失败。".to_string())?;if row.4!=1||!ct_eq_hex(&password_hash(&input.password,&salt)?,&row.5){return Ok(OpResult{ok:false,error:Some("账户验证失败。".into()),user:None})}let user=UserSession{id:row.0,username:row.1,display_name:row.2,role:row.3};rt.db=Some(db);rt.db_key=Some(key);rt.user=Some(user.clone());rt.paths=Some(p);rt.failures.remove(&input.username);if let (Some(paths),Some(db),Some(key))=(rt.paths.clone(),rt.db.as_ref(),rt.db_key){daily_auto_backup(&paths,db,&key)}audit(&rt,"登录","用户",&user.id,"成功","")?;Ok(OpResult{ok:true,error:None,user:Some(user)})}
#[tauri::command] fn auth_status(state:State<AppState>)->Result<AuthStatus,String>{let rt=state.0.lock().unwrap();Ok(AuthStatus{needs_setup:false,authenticated:rt.user.is_some(),user:rt.user.clone()})}
#[tauri::command] fn auth_lock(state:State<AppState>)->Result<Value,String>{let mut rt=state.0.lock().unwrap();if rt.user.is_some(){audit(&rt,"锁定工作台","安全","","成功","")?}rt.user=None;rt.db=None;rt.db_key=None;Ok(json!({"ok":true}))}
#[tauri::command] fn db_get_state(state:State<AppState>)->Result<String,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;Ok(workspace(rt.db.as_ref().unwrap())?.to_string())}
#[tauri::command] fn db_set_state(state:State<AppState>,json:String)->Result<bool,String>{let x:Value=serde_json::from_str(&json).map_err(|_|"数据格式无效".to_string())?;if !x.is_object()||!x["clients"].is_array()||!x["sessions"].is_array()||!x["events"].is_array(){return Err("数据不完整，已拒绝写入（防止误清空）".into())}let mut rt=state.0.lock().unwrap();require_user(&rt)?;let old=workspace(rt.db.as_ref().unwrap())?;replace_workspace(rt.db.as_mut().unwrap(),&x)?;if old!=x{audit(&rt,"保存修改","工作台","","成功","业务数据已更新")?}Ok(true)}
#[tauri::command] fn db_list_prefs(state:State<AppState>)->Result<Value,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;let mut st=rt.db.as_ref().unwrap().prepare("SELECT key,value FROM preferences").map_err(|e|e.to_string())?;let rows=st.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?;let mut map=serde_json::Map::new();for row in rows{let (k,v)=row.map_err(|e|e.to_string())?;map.insert(k,Value::String(v));}Ok(Value::Object(map))}

#[tauri::command] fn db_get_pref(state:State<AppState>,key:String)->Result<Option<String>,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;rt.db.as_ref().unwrap().query_row("SELECT value FROM preferences WHERE key=?",[key],|r|r.get(0)).optional().map_err(|e|e.to_string())}
#[tauri::command] fn db_set_pref(state:State<AppState>,key:String,val:String)->Result<bool,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;rt.db.as_ref().unwrap().execute("INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,val]).map_err(|e|e.to_string())?;Ok(true)}
#[tauri::command] fn db_remove_pref(state:State<AppState>,key:String)->Result<bool,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;rt.db.as_ref().unwrap().execute("DELETE FROM preferences WHERE key=?",[key]).map_err(|e|e.to_string())?;Ok(true)}
#[tauri::command] fn db_info(state:State<AppState>)->Result<Value,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;let p=rt.paths.as_ref().ok_or("路径未初始化")?;Ok(json!({"dbPath":p.db,"backupDir":p.backups,"dataDir":p.data,"portableMode":p.data.parent().map(|x|x.join("portable.mode").exists()).unwrap_or(false),"size":fs::metadata(&p.db).map(|m|m.len()).unwrap_or(0),"encrypted":true,"integrity":"ok"}))}
#[tauri::command] fn db_backup(state:State<AppState>)->Result<Value,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;let p=rt.paths.as_ref().ok_or("路径未初始化")?;rt.db.as_ref().unwrap().execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").map_err(|e|e.to_string())?;let file=p.backups.join(format!("workspace_{}_manual.db",Utc::now().format("%Y-%m-%dT%H-%M-%S%.3f")));fs::copy(&p.db,&file).map_err(|e|e.to_string())?;let chk=open_db(&file,&rt.db_key.ok_or("数据库未解锁")?)?;let ok:String=chk.query_row("PRAGMA integrity_check",[],|r|r.get(0)).map_err(|e|e.to_string())?;if ok.to_lowercase()!="ok"{let _=fs::remove_file(&file);return Err("备份完整性验证失败".into())}audit(&rt,"创建数据库备份","备份","","成功",file.file_name().and_then(|x|x.to_str()).unwrap_or(""))?;Ok(json!({"ok":true,"file":file,"verified":true}))}
#[tauri::command] fn audit_list(state:State<AppState>,limit:Option<u32>)->Result<Vec<Value>,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;let n=limit.unwrap_or(300).min(1000);let mut st=rt.db.as_ref().unwrap().prepare("SELECT id,ts,username,action,object_type,object_id,result,detail FROM audit_log ORDER BY id DESC LIMIT ?").map_err(|e|e.to_string())?;let rows=st.query_map([n],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"ts":r.get::<_,String>(1)?,"username":r.get::<_,String>(2)?,"action":r.get::<_,String>(3)?,"object_type":r.get::<_,Option<String>>(4)?,"object_id":r.get::<_,Option<String>>(5)?,"result":r.get::<_,String>(6)?,"detail":r.get::<_,Option<String>>(7)?}))).map_err(|e|e.to_string())?;Ok(rows.filter_map(Result::ok).collect())}
#[tauri::command] fn audit_event(state:State<AppState>,input:AuditEventInput)->Result<bool,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;audit(&rt,&input.action,input.object_type.as_deref().unwrap_or(""),input.object_id.as_deref().unwrap_or(""),"成功",input.detail.as_deref().unwrap_or(""))?;Ok(true)}
#[tauri::command] fn audit_verify(state:State<AppState>)->Result<Value,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;let mut st=rt.db.as_ref().unwrap().prepare("SELECT ts,user_id,username,action,object_type,object_id,result,detail,prev_hash,entry_hash FROM audit_log ORDER BY id").map_err(|e|e.to_string())?;let mut rows=st.query([]).map_err(|e|e.to_string())?;let mut prev="GENESIS".to_string();let key=audit_key(&rt)?;let mut ok=true;while let Some(r)=rows.next().map_err(|e|e.to_string())?{let vals:(String,Option<String>,String,String,Option<String>,Option<String>,String,Option<String>,String,String)=(r.get(0).map_err(|e|e.to_string())?,r.get(1).map_err(|e|e.to_string())?,r.get(2).map_err(|e|e.to_string())?,r.get(3).map_err(|e|e.to_string())?,r.get(4).map_err(|e|e.to_string())?,r.get(5).map_err(|e|e.to_string())?,r.get(6).map_err(|e|e.to_string())?,r.get(7).map_err(|e|e.to_string())?,r.get(8).map_err(|e|e.to_string())?,r.get(9).map_err(|e|e.to_string())?);let payload=format!("{}|{}|{}|{}|{}|{}|{}|{}|{}",vals.0,vals.1.unwrap_or_default(),vals.2,vals.3,vals.4.unwrap_or_default(),vals.5.unwrap_or_default(),vals.6,vals.7.unwrap_or_default(),prev);let mut mac=<HmacSha256 as Mac>::new_from_slice(&key).map_err(|e|e.to_string())?;mac.update(payload.as_bytes());let h=hex::encode(mac.finalize().into_bytes());if vals.8!=prev||vals.9!=h{ok=false;break}prev=vals.9}drop(rows);drop(st);audit(&rt,"校验审计日志","审计日志","",if ok{"成功"}else{"失败"},if ok{"完整性校验通过"}else{"检测到日志链异常"})?;Ok(json!({"ok":ok}))}
#[tauri::command] fn users_list(state:State<AppState>)->Result<Vec<Value>,String>{let rt=state.0.lock().unwrap();require_admin(&rt)?;let mut st=rt.db.as_ref().unwrap().prepare("SELECT id,username,display_name,role,active,created_at,updated_at FROM users ORDER BY created_at").map_err(|e|e.to_string())?;let rows=st.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"username":r.get::<_,String>(1)?,"display_name":r.get::<_,String>(2)?,"role":r.get::<_,String>(3)?,"active":r.get::<_,i64>(4)?==1,"created_at":r.get::<_,String>(5)?,"updated_at":r.get::<_,String>(6)?}))).map_err(|e|e.to_string())?;Ok(rows.filter_map(Result::ok).collect())}
#[tauri::command] fn users_create(state:State<AppState>,input:CreateUserInput)->Result<OpResult,String>{let mut rt=state.0.lock().unwrap();require_admin(&rt)?;if input.username.trim().len()<2||input.password.len()<10{return Ok(OpResult{ok:false,error:Some("用户名至少 2 个字符，密码至少 10 位。".into()),user:None})}let salt=random16();let id=Uuid::new_v4().to_string();let role=if input.role=="管理员"{"管理员"}else{"咨询师"};let db=rt.db.as_ref().unwrap();let r=db.execute("INSERT INTO users(id,username,display_name,password_hash,salt,role,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)",params![id,input.username.trim(),if input.display_name.trim().is_empty(){input.username.trim()}else{input.display_name.trim()},password_hash(&input.password,&salt)?,hex::encode(salt),role,now(),now()]);if let Err(e)=r{return Ok(OpResult{ok:false,error:Some(format!("创建用户失败：{e}")),user:None})}let p=rt.paths.as_ref().unwrap();let mut a=read_access(&p.access);a.users.push(AccessUser{id:id.clone(),username:input.username.trim().into(),display_name:input.display_name.trim().into(),role:role.into(),active:true,salt:hex::encode(salt),verifier:verifier(&input.password,&salt)?,wrapped_key:wrap_key(&rt.db_key.unwrap(),&input.password,&salt)?});write_access(&p.access,&a)?;audit(&rt,"创建用户","用户",&id,"成功",role)?;Ok(OpResult{ok:true,error:None,user:None})}
#[tauri::command] fn users_set_active(state:State<AppState>,input:ActiveInput)->Result<OpResult,String>{let rt=state.0.lock().unwrap();let me=require_admin(&rt)?;if me.id==input.id&&!input.active{return Ok(OpResult{ok:false,error:Some("不能停用当前登录账户。".into()),user:None})}let db=rt.db.as_ref().unwrap();if !input.active {let target_role:Option<String>=db.query_row("SELECT role FROM users WHERE id=?",[&input.id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;if target_role.as_deref()==Some("管理员"){let active_admins:i64=db.query_row("SELECT COUNT(*) FROM users WHERE role='管理员' AND active=1",[],|r|r.get(0)).map_err(|e|e.to_string())?;if active_admins<=1{return Ok(OpResult{ok:false,error:Some("至少需要保留一个启用的管理员账户。".into()),user:None})}}}db.execute("UPDATE users SET active=?,updated_at=? WHERE id=?",params![if input.active{1}else{0},now(),input.id]).map_err(|e|e.to_string())?;let p=rt.paths.as_ref().unwrap();let mut a=read_access(&p.access);if let Some(u)=a.users.iter_mut().find(|u|u.id==input.id){u.active=input.active}write_access(&p.access,&a)?;audit(&rt,if input.active{"启用用户"}else{"停用用户"},"用户",&input.id,"成功","")?;Ok(OpResult{ok:true,error:None,user:None})}
#[tauri::command] fn change_password(state:State<AppState>,input:ChangePasswordInput)->Result<OpResult,String>{let rt=state.0.lock().unwrap();let u=require_user(&rt)?.clone();if input.new_password.len()<10{return Ok(OpResult{ok:false,error:Some("新密码至少 10 位。".into()),user:None})}let db=rt.db.as_ref().unwrap();let row:(String,String)=db.query_row("SELECT password_hash,salt FROM users WHERE id=?",[&u.id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;let oldsalt=hex::decode(row.1).map_err(|_|"账户凭据损坏".to_string())?;if !ct_eq_hex(&password_hash(&input.current_password,&oldsalt)?,&row.0){return Ok(OpResult{ok:false,error:Some("当前密码不正确。".into()),user:None})}let salt=random16();db.execute("UPDATE users SET password_hash=?,salt=?,updated_at=? WHERE id=?",params![password_hash(&input.new_password,&salt)?,hex::encode(salt),now(),u.id]).map_err(|e|e.to_string())?;let p=rt.paths.as_ref().unwrap();let mut a=read_access(&p.access);if let Some(x)=a.users.iter_mut().find(|x|x.id==u.id){x.salt=hex::encode(salt);x.verifier=verifier(&input.new_password,&salt)?;x.wrapped_key=wrap_key(&rt.db_key.unwrap(),&input.new_password,&salt)?}write_access(&p.access,&a)?;audit(&rt,"修改密码","用户",&u.id,"成功","")?;Ok(OpResult{ok:true,error:None,user:None})}

#[tauri::command] fn open_path(app:AppHandle,state:State<AppState>,kind:String)->Result<bool,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;let p=rt.paths.as_ref().ok_or("路径未初始化")?;let target=if kind=="backup"{&p.backups}else{&p.data};tauri_plugin_opener::OpenerExt::opener(&app).open_path(target.to_string_lossy().to_string(),None::<&str>).map_err(|e|e.to_string())?;Ok(true)}
#[tauri::command] fn open_external(app:AppHandle,url:String)->Result<bool,String>{if url!="https://mindx.us/zh/"{return Err("Blocked external URL".into())}tauri_plugin_opener::OpenerExt::opener(&app).open_url(url,None::<&str>).map_err(|e|e.to_string())?;Ok(true)}

pub fn run(){
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_opener::init()).manage(AppState(Mutex::new(Runtime::default()))).manage(components::CompState(Mutex::new(components::CompRuntime::default())));
    let handler = tauri::generate_handler![startup_status,startup_setup,startup_login,auth_status,auth_lock,db_get_state,db_set_state,db_list_prefs,db_get_pref,db_set_pref,db_remove_pref,db_info,db_backup,audit_list,audit_verify,audit_event,users_list,users_create,users_set_active,change_password,open_path,open_external,components::ai_comp_status,components::ai_comp_install,components::ai_comp_poll,components::ai_comp_remove,components::ai_status,components::ai_download,components::ai_download_cancel,components::ai_set_engine_path,components::ai_import_model,components::audio_begin,components::audio_append,components::audio_finish,components::audio_discard,components::transcribe_start,components::generate_start,components::ai_proc_poll,components::ai_proc_cancel];
    builder.invoke_handler(handler).run(tauri::generate_context!()).expect("error while running Tauri application");
}
