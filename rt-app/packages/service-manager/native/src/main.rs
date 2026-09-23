use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    env,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::{ProcessesToUpdate, System};
// Thread count for the process identified by the displayed PID.
fn process_threads(pid: u32) -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_taskinfo>() as i32;
        let read = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTASKINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if read == size {
            return Some(unsafe { info.assume_init() }.pti_threadnum as u64);
        }
        None
    }
    #[cfg(target_os = "linux")]
    {
        fs::read_to_string(format!("/proc/{pid}/status"))
            .ok()?
            .lines()
            .find_map(|line| {
                line.strip_prefix("Threads:")
                    .and_then(|value| value.trim().parse().ok())
            })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        None
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spec {
    id: String,
    label: String,
    command: Vec<String>,
    cwd: String,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    inherit_env: Vec<String>,
    #[serde(default)]
    dependencies: Vec<String>,
    #[serde(default)]
    ports: Vec<u16>,
    url: Option<String>,
    ready_url: Option<String>,
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default = "default_stop_timeout")]
    stop_timeout_ms: u64,
    #[serde(default = "yes")]
    enabled: bool,
}
fn default_stop_timeout() -> u64 {
    10000
}
fn default_kind() -> String {
    "service".into()
}
fn yes() -> bool {
    true
}
#[derive(Deserialize)]
struct Config {
    services: Vec<Spec>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Log {
    sequence: u64,
    time: u128,
    stream: String,
    text: String,
}
struct Service {
    spec: Spec,
    child: Option<Child>,
    state: String,
    desired: bool,
    pid: Option<u32>,
    error: Option<String>,
    exit_code: Option<i32>,
    since: Option<Instant>,
    stop_at: Option<Instant>,
    generation: u64,
    cancel: Arc<AtomicBool>,
    logs: Arc<Mutex<VecDeque<Log>>>,
    cpu: f32,
    cpu_time_ms: u64,
    threads: Option<u64>,
    memory: u64,
}
struct Engine {
    root: PathBuf,
    services: BTreeMap<String, Service>,
    health_tx: mpsc::Sender<(String, u64, Result<(), String>)>,
    health_rx: mpsc::Receiver<(String, u64, Result<(), String>)>,
    system: System,
    last_metrics: Instant,
}
fn epoch() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
fn clean(text: &str) -> String {
    let mut result = String::new();
    let mut escape = false;
    for c in text.chars() {
        if c == '\x1b' {
            escape = true;
            continue;
        }
        if escape {
            if c.is_ascii_alphabetic() {
                escape = false;
            }
            continue;
        }
        if !c.is_control() || c == '\t' {
            result.push(c);
        }
    }
    result
}
fn log(logs: &Arc<Mutex<VecDeque<Log>>>, stream: &str, text: String) {
    let mut rows = logs.lock().unwrap();
    let sequence = rows.back().map(|r| r.sequence + 1).unwrap_or(1);
    rows.push_back(Log {
        sequence,
        time: epoch(),
        stream: stream.into(),
        text: clean(&text),
    });
    while rows.len() > 600 {
        rows.pop_front();
    }
}
fn capture<R: Read + Send + 'static>(
    mut reader: R,
    logs: Arc<Mutex<VecDeque<Log>>>,
    stream: &'static str,
    secrets: Vec<String>,
) {
    thread::spawn(move || {
        let mut buffer = [0u8; 1024];
        let mut line = Vec::new();
        loop {
            let n = reader.read(&mut buffer).unwrap_or(0);
            for &b in &buffer[..n] {
                if b == b'\n' || line.len() >= 4096 {
                    let mut text = String::from_utf8_lossy(&line).into_owned();
                    for secret in &secrets {
                        text = text.replace(secret, "[redacted]");
                    }
                    log(&logs, stream, text);
                    line.clear();
                }
                if b != b'\n' {
                    line.push(b);
                }
            }
            if n == 0 {
                if !line.is_empty() {
                    let mut text = String::from_utf8_lossy(&line).into_owned();
                    for secret in &secrets {
                        text = text.replace(secret, "[redacted]");
                    }
                    log(&logs, stream, text);
                }
                break;
            }
        }
    });
}
fn private_file(path: &Path) -> io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}
fn signal(child: &mut Child, force: bool) {
    #[cfg(unix)]
    unsafe {
        libc::kill(
            -(child.id() as i32),
            if force { libc::SIGKILL } else { libc::SIGTERM },
        );
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status();
    }
    if force {
        let _ = child.kill();
    }
}
fn healthy(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("http://127.0.0.1:")
        .or_else(|| url.strip_prefix("http://localhost:"))
    else {
        return false;
    };
    let (port, path) = rest.split_once('/').unwrap_or((rest, ""));
    let Ok(port) = port.parse::<u16>() else {
        return false;
    };
    let Ok(mut socket) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(500),
    ) else {
        return false;
    };
    let _ = socket.set_read_timeout(Some(Duration::from_millis(900)));
    let _ = socket.set_write_timeout(Some(Duration::from_millis(500)));
    if write!(
        socket,
        "GET /{path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .is_err()
    {
        return false;
    }
    let mut data = [0u8; 256];
    let n = socket.read(&mut data).unwrap_or(0);
    let code = String::from_utf8_lossy(&data[..n])
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    (200..400).contains(&code)
}
impl Engine {
    fn new(root: PathBuf, config: Config) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel();
        let mut services = BTreeMap::new();
        let mut ports = HashSet::new();
        for spec in config.services {
            if spec.id.is_empty()
                || !spec
                    .id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                || spec.command.is_empty()
                || !(1000..=60000).contains(&spec.stop_timeout_ms)
                || !matches!(spec.kind.as_str(), "service" | "task")
            {
                return Err("Invalid service definition".into());
            }
            if services.contains_key(&spec.id) {
                return Err("Duplicate service ID".into());
            }
            let cwd = root
                .join(&spec.cwd)
                .canonicalize()
                .map_err(|e| e.to_string())?;
            if !cwd.starts_with(&root) {
                return Err("Service directory must be inside the project".into());
            }
            for port in &spec.ports {
                if *port < 1024 || !ports.insert(*port) {
                    return Err("Ports must be distinct and >= 1024".into());
                }
            }
            for url in [spec.url.as_ref(), spec.ready_url.as_ref()]
                .into_iter()
                .flatten()
            {
                if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:"))
                    || url.contains(['\r', '\n'])
                {
                    return Err("Service URLs must use loopback HTTP".into());
                }
            }
            services.insert(
                spec.id.clone(),
                Service {
                    spec,
                    child: None,
                    state: "stopped".into(),
                    desired: false,
                    pid: None,
                    error: None,
                    exit_code: None,
                    since: None,
                    stop_at: None,
                    generation: 0,
                    cancel: Arc::new(AtomicBool::new(false)),
                    logs: Arc::new(Mutex::new(VecDeque::new())),
                    cpu: 0.,
                    cpu_time_ms: 0,
                    threads: None,
                    memory: 0,
                },
            );
        }
        let engine = Self {
            root,
            services,
            health_tx: tx,
            health_rx: rx,
            system: System::new(),
            last_metrics: Instant::now() - Duration::from_secs(2),
        };
        for id in engine.services.keys() {
            engine.dependencies(id, &mut HashSet::new())?;
        }
        Ok(engine)
    }
    fn dependencies(&self, id: &str, active: &mut HashSet<String>) -> Result<(), String> {
        let service = self
            .services
            .get(id)
            .ok_or(format!("Unknown service: {id}"))?;
        if !active.insert(id.into()) {
            return Err(format!("Dependency cycle: {id}"));
        }
        for dep in &service.spec.dependencies {
            self.dependencies(dep, active)?;
        }
        active.remove(id);
        Ok(())
    }
    fn request_start(&mut self, id: &str) -> Result<(), String> {
        let deps = self
            .services
            .get(id)
            .ok_or("Unknown service")?
            .spec
            .dependencies
            .clone();
        for dep in deps {
            self.request_start(&dep)?;
        }
        let s = self.services.get_mut(id).unwrap();
        if s.state != "completed" && s.child.is_none() {
            s.state = "waiting".into();
            s.error = None;
            s.exit_code = None;
        }
        s.desired = true;
        Ok(())
    }
    fn descendants(&self, id: &str) -> HashSet<String> {
        let mut ids = HashSet::from([id.to_string()]);
        loop {
            let old = ids.len();
            for (k, s) in &self.services {
                if s.spec.dependencies.iter().any(|d| ids.contains(d)) {
                    ids.insert(k.clone());
                }
            }
            if ids.len() == old {
                break;
            }
        }
        ids
    }
    fn stop(&mut self, id: &str, restart: bool) {
        for name in self.descendants(id) {
            let s = self.services.get_mut(&name).unwrap();
            s.cancel.store(true, Ordering::Relaxed);
            s.desired = restart && s.desired;
            if let Some(c) = s.child.as_mut() {
                signal(c, false);
                s.state = "stopping".into();
                s.stop_at = Some(Instant::now());
            } else {
                s.state = if s.desired { "waiting" } else { "stopped" }.into();
            }
            s.error = None;
        }
    }
    fn action(&mut self, action: &str, id: Option<&str>) -> Result<Value, String> {
        match action {
            "status" => {}
            "logs" => {
                let s = self
                    .services
                    .get(id.ok_or("Service required")?)
                    .ok_or("Unknown service")?;
                return Ok(json!(s.logs.lock().unwrap().clone()));
            }
            "start" | "stop" | "restart" => {
                let ids = if id == Some("all") {
                    self.services
                        .iter()
                        .filter(|(_, s)| action == "stop" || s.spec.enabled)
                        .map(|(id, _)| id.clone())
                        .collect::<Vec<_>>()
                } else {
                    vec![id.ok_or("Service required")?.to_string()]
                };
                for name in ids {
                    if !self.services.contains_key(&name) {
                        return Err("Unknown service".into());
                    }
                    if action != "start" {
                        self.stop(&name, action == "restart");
                    }
                    if action != "stop" {
                        if action == "restart" {
                            let s = self.services.get_mut(&name).unwrap();
                            if s.state == "completed" {
                                s.state = "stopped".into();
                            }
                        }
                        self.request_start(&name)?;
                    }
                }
            }
            _ => return Err("Unknown action".into()),
        }
        Ok(self.snapshot())
    }
    fn snapshot(&self) -> Value {
        json!({"project":self.root,"services":self.services.values().map(|s|json!({"id":s.spec.id,"label":s.spec.label,"kind":s.spec.kind,"enabled":s.spec.enabled,"state":s.state,"pid":s.pid,"url":s.spec.url,"error":s.error,"exitCode":s.exit_code,"cpu":s.cpu,"cpuTimeMs":s.cpu_time_ms,"threads":s.threads,"memoryMb":s.memory as f64/1048576.,"uptimeSeconds":s.since.map(|t|t.elapsed().as_secs()),"dependencies":s.spec.dependencies,"ports":s.spec.ports})).collect::<Vec<_>>()})
    }
    fn tick(&mut self) {
        for (id, generation, result) in self.health_rx.try_iter() {
            if let Some(s) = self.services.get_mut(&id) {
                if s.generation == generation && s.state == "starting" {
                    match result {
                        Ok(()) => s.state = "running".into(),
                        Err(e) => {
                            s.error = Some(e);
                            s.desired = false;
                            if let Some(c) = s.child.as_mut() {
                                signal(c, false);
                            }
                            s.stop_at = Some(Instant::now());
                            s.state = "failed".into();
                        }
                    }
                }
            }
        }
        for s in self.services.values_mut() {
            if let Some(child) = s.child.as_mut() {
                if s.stop_at
                    .is_some_and(|at| at.elapsed() > Duration::from_millis(s.spec.stop_timeout_ms))
                {
                    signal(child, true);
                }
                if let Ok(Some(status)) = child.try_wait() {
                    signal(child, true);
                    let was_stopping = s.state == "stopping";
                    s.cancel.store(true, Ordering::Relaxed);
                    s.exit_code = status.code();
                    s.pid = None;
                    s.cpu = 0.;
                    s.memory = 0;
                    s.stop_at = None;
                    s.child = None;
                    if was_stopping {
                        s.state = if s.desired { "waiting" } else { "stopped" }.into();
                    } else if s.spec.kind == "task" && status.success() && s.error.is_none() {
                        s.state = "completed".into();
                    } else {
                        s.state = "failed".into();
                        s.desired = false;
                        s.error
                            .get_or_insert(format!("Process exited ({status}). See output."));
                    }
                }
            }
        }
        let waiting = self
            .services
            .iter()
            .filter(|(_, s)| s.desired && s.child.is_none() && s.state == "waiting")
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in waiting {
            let deps = self.services[&id].spec.dependencies.clone();
            if let Some(dep) = deps.iter().find(|dep| {
                self.services[*dep].state == "failed" || self.services[*dep].state == "blocked"
            }) {
                let s = self.services.get_mut(&id).unwrap();
                s.state = "failed".into();
                s.desired = false;
                s.error = Some(format!("Dependency {dep} failed"));
                continue;
            }
            if !deps
                .iter()
                .all(|dep| matches!(self.services[dep].state.as_str(), "running" | "completed"))
            {
                continue;
            }
            let s = self.services.get_mut(&id).unwrap();
            let mut reservations = Vec::new();
            for port in &s.spec.ports {
                match TcpListener::bind(("127.0.0.1", *port)) {
                    Ok(listener) => reservations.push(listener),
                    Err(_) => {
                        s.state = "blocked".into();
                        s.desired = false;
                        s.error = Some(format!(
                            "Port {port} is occupied by another process. It was not stopped."
                        ));
                        break;
                    }
                }
            }
            if !s.desired {
                continue;
            }
            let mut cmd = Command::new(&s.spec.command[0]);
            cmd.args(&s.spec.command[1..])
                .current_dir(self.root.join(&s.spec.cwd))
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .env_clear();
            for key in [
                "PATH",
                "HOME",
                "USERPROFILE",
                "SystemRoot",
                "COMSPEC",
                "PATHEXT",
                "TMPDIR",
                "TEMP",
                "TMP",
                "LANG",
                "LC_ALL",
                "CARGO_HOME",
                "RUSTUP_HOME",
            ] {
                if let Ok(value) = env::var(key) {
                    cmd.env(key, value);
                }
            }
            let mut secrets = Vec::new();
            for key in &s.spec.inherit_env {
                if let Ok(value) = env::var(key) {
                    if value.len() >= 8 {
                        secrets.push(value.clone());
                    }
                    cmd.env(key, value);
                }
            }
            cmd.envs(&s.spec.env);
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                cmd.process_group(0);
            }
            drop(reservations);
            match cmd.spawn() {
                Ok(mut child) => {
                    s.generation += 1;
                    s.cpu_time_ms = 0;
                    s.threads = None;
                    s.pid = Some(child.id());
                    s.since = Some(Instant::now());
                    s.cancel = Arc::new(AtomicBool::new(false));
                    log(
                        &s.logs,
                        "supervisor",
                        format!("Started process {}", child.id()),
                    );
                    capture(
                        child.stdout.take().unwrap(),
                        s.logs.clone(),
                        "stdout",
                        secrets.clone(),
                    );
                    capture(
                        child.stderr.take().unwrap(),
                        s.logs.clone(),
                        "stderr",
                        secrets,
                    );
                    s.child = Some(child);
                    s.state = if s.spec.ready_url.is_some() {
                        "starting"
                    } else {
                        "running"
                    }
                    .into();
                    if let Some(url) = s.spec.ready_url.clone() {
                        let (tx, id, generation, cancel) = (
                            self.health_tx.clone(),
                            id.clone(),
                            s.generation,
                            s.cancel.clone(),
                        );
                        thread::spawn(move || {
                            let deadline = Instant::now() + Duration::from_secs(90);
                            while !cancel.load(Ordering::Relaxed) {
                                if healthy(&url) {
                                    let _ = tx.send((id, generation, Ok(())));
                                    return;
                                }
                                if Instant::now() > deadline {
                                    let _ = tx.send((
                                        id,
                                        generation,
                                        Err("Readiness timed out. See service output.".into()),
                                    ));
                                    return;
                                }
                                thread::sleep(Duration::from_millis(300));
                            }
                        });
                    }
                }
                Err(e) => {
                    s.state = "failed".into();
                    s.desired = false;
                    s.error = Some(format!("Could not start {}: {e}", s.spec.command[0]));
                    log(&s.logs, "supervisor", s.error.clone().unwrap());
                }
            }
        }
        if self.last_metrics.elapsed() > Duration::from_secs(1) {
            self.system.refresh_processes(ProcessesToUpdate::All, true);
            for s in self.services.values_mut() {
                s.cpu = 0.;
                s.memory = 0;
                s.threads = None;
                if s.child.is_none()
                    && !s.desired
                    && matches!(s.state.as_str(), "stopped" | "blocked")
                {
                    if let Some(port) = s
                        .spec
                        .ports
                        .iter()
                        .find(|port| TcpListener::bind(("127.0.0.1", **port)).is_err())
                    {
                        s.state = "blocked".into();
                        s.error = Some(format!(
                            "Port {port} is occupied by an unmanaged process. Stop its original launcher before starting here."
                        ));
                    } else if s.state == "blocked" {
                        s.state = "stopped".into();
                        s.error = None;
                    }
                }
                if let Some(pid) = s.pid {
                    s.threads = process_threads(pid);
                    if let Some(p) = self.system.process(sysinfo::Pid::from_u32(pid)) {
                        s.cpu_time_ms = p.accumulated_cpu_time();
                    }
                    let mut pids = HashSet::from([sysinfo::Pid::from_u32(pid)]);
                    loop {
                        let n = pids.len();
                        for (pid, p) in self.system.processes() {
                            if p.parent().is_some_and(|parent| pids.contains(&parent)) {
                                pids.insert(*pid);
                            }
                        }
                        if pids.len() == n {
                            break;
                        }
                    }
                    for pid in pids {
                        if let Some(p) = self.system.process(pid) {
                            s.cpu += p.cpu_usage();
                            s.memory += p.memory();
                        }
                    }
                }
            }
            self.last_metrics = Instant::now();
        }
    }
}
#[derive(Serialize, Deserialize)]
struct Registry {
    port: u16,
    token: String,
    pid: u32,
}
fn serve(root: PathBuf, path: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let dir = root.join(".rt-app");
    fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(dir.join("supervisor.lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| "Supervisor already running for this project")?;
    let config: Config = serde_json::from_reader(File::open(&path)?)?;
    let engine = Arc::new(Mutex::new(Engine::new(root.clone(), config)?));
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("Random token: {e}"))?;
    let token = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let registry = Registry {
        port: listener.local_addr()?.port(),
        token: token.clone(),
        pid: std::process::id(),
    };
    serde_json::to_writer(private_file(&dir.join("supervisor.json"))?, &registry)?;
    let quit = Arc::new(AtomicBool::new(false));
    let q = quit.clone();
    ctrlc::set_handler(move || q.store(true, Ordering::Relaxed))?;
    while !quit.load(Ordering::Relaxed) {
        engine.lock().unwrap().tick();
        match listener.accept() {
            Ok((mut stream, _)) => {
                let (engine, token, quit, path, root) = (
                    engine.clone(),
                    token.clone(),
                    quit.clone(),
                    path.clone(),
                    root.clone(),
                );
                thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                    let mut line = String::new();
                    let result = (|| -> Result<Value, String> {
                        BufReader::new((&mut stream).take(16385))
                            .read_line(&mut line)
                            .map_err(|e| e.to_string())?;
                        if line.len() > 16384 {
                            return Err("Request too large".into());
                        }
                        let request: Value =
                            serde_json::from_str(&line).map_err(|_| "Invalid request")?;
                        if request["token"].as_str() != Some(&token) {
                            return Err("Unauthorized".into());
                        }
                        let action = request["action"].as_str().ok_or("Action required")?;
                        if action == "reload" {
                            let config: Config = serde_json::from_reader(
                                File::open(&path).map_err(|e| e.to_string())?,
                            )
                            .map_err(|e| e.to_string())?;
                            let replacement = Engine::new(root, config)?;
                            let mut current = engine.lock().unwrap();
                            if current
                                .services
                                .values()
                                .any(|s| s.child.is_some() || s.desired)
                            {
                                return Err(
                                    "Stop all services before reloading configuration".into()
                                );
                            }
                            *current = replacement;
                            return Ok(current.snapshot());
                        }
                        if action == "shutdown" {
                            quit.store(true, Ordering::Relaxed);
                            return Ok(json!({"stopping":true}));
                        }
                        engine
                            .lock()
                            .unwrap()
                            .action(action, request["service"].as_str())
                    })();
                    let response = match result {
                        Ok(data) => json!({"ok":true,"data":data}),
                        Err(error) => json!({"ok":false,"error":error}),
                    };
                    let _ = writeln!(stream, "{response}");
                    let _ = stream.shutdown(Shutdown::Both);
                });
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(e.into()),
        }
        thread::sleep(Duration::from_millis(100));
    }
    {
        let mut e = engine.lock().unwrap();
        let ids = e.services.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            e.stop(&id, false);
        }
    }
    let timeout = engine
        .lock()
        .unwrap()
        .services
        .values()
        .map(|s| s.spec.stop_timeout_ms)
        .max()
        .unwrap_or(10000);
    let deadline = Instant::now() + Duration::from_millis(timeout + 1000);
    while Instant::now() < deadline {
        let mut e = engine.lock().unwrap();
        e.tick();
        if e.services.values().all(|s| s.child.is_none()) {
            break;
        }
        drop(e);
        thread::sleep(Duration::from_millis(100));
    }
    for s in engine.lock().unwrap().services.values_mut() {
        if let Some(c) = s.child.as_mut() {
            signal(c, true);
            let _ = c.wait();
        }
    }
    fs::remove_file(dir.join("supervisor.json"))?;
    Ok(())
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let root = args
        .iter()
        .position(|a| a == "--project")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or(env::current_dir()?)
        .canonicalize()?;
    let command = args.first().map(String::as_str).unwrap_or("status");
    if command == "serve" {
        let path = args
            .iter()
            .position(|a| a == "--config")
            .and_then(|i| args.get(i + 1))
            .ok_or("--config required")?;
        return serve(root, PathBuf::from(path));
    }
    let registry: Registry =
        serde_json::from_reader(File::open(root.join(".rt-app/supervisor.json")).map_err(
            |_| "Supervisor is not running. Run rta services daemon or rta desktop first.",
        )?)?;
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", registry.port).parse()?,
        Duration::from_secs(2),
    )?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let service = args.get(1).filter(|s| !s.starts_with("--"));
    writeln!(
        stream,
        "{}",
        json!({"token":registry.token,"action":command,"service":service})
    )?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    let value: Value = serde_json::from_str(&line)?;
    if value["ok"] != true {
        return Err(value["error"].as_str().unwrap_or("Request failed").into());
    }
    println!("{}", value["data"]);
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{}", json!({"error":e.to_string()}));
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn spec(id: &str, deps: Vec<&str>) -> Spec {
        Spec {
            id: id.into(),
            label: id.into(),
            command: vec!["true".into()],
            cwd: ".".into(),
            env: BTreeMap::new(),
            inherit_env: vec![],
            dependencies: deps.iter().map(|s| s.to_string()).collect(),
            ports: vec![],
            url: None,
            ready_url: None,
            kind: "task".into(),
            stop_timeout_ms: 10000,
            enabled: true,
        }
    }
    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn reads_current_process_threads() {
        assert!(process_threads(std::process::id()).unwrap() >= 1);
        assert_eq!(process_threads(u32::MAX), None);
    }
    #[test]
    fn rejects_cycles() {
        assert!(
            Engine::new(
                env::current_dir().unwrap(),
                Config {
                    services: vec![spec("a", vec!["b"]), spec("b", vec!["a"])]
                }
            )
            .is_err()
        );
    }
    #[test]
    fn rejects_missing_dependencies() {
        assert!(
            Engine::new(
                env::current_dir().unwrap(),
                Config {
                    services: vec![spec("a", vec!["missing"])]
                }
            )
            .is_err()
        );
    }
    #[test]
    fn start_and_stop_include_dependencies() {
        let mut e = Engine::new(
            env::current_dir().unwrap(),
            Config {
                services: vec![spec("a", vec![]), spec("b", vec!["a"])],
            },
        )
        .unwrap();
        e.request_start("b").unwrap();
        assert!(e.services["a"].desired);
        e.stop("a", false);
        assert!(!e.services["b"].desired);
    }
}
