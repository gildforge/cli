//! gild guest agent: one exec contract for every isolation backend.
//!
//! Wire format (both directions): `[u32 big-endian length][JSON]`.
//!
//! Host to agent, one request per connection:
//!   {"op":"put","path":"/workspace/x","mode":384,"content":"<base64>"}
//!   {"op":"exec","argv":[..],"env":{..},"cwd":"/workspace","timeout_ms":1000}
//!   {"op":"ping"}                         (also the version handshake, see below)
//!   {"op":"list","root":"/workspace"}       (sync: every entry under root, hashed)
//!   {"op":"get","path":"/workspace/x"}      (sync: one regular file's bytes)
//! Agent to host:
//!   {"t":"out","d":"<base64>"} / {"t":"err","d":"<base64>"}   (exec, streamed)
//!   {"t":"exit","code":0,"timed_out":false}                   (exec, last frame)
//!   {"t":"ok"} / {"t":"error","message":".."}                 (put; last frame of list/get)
//!   {"t":"ok","protocol":2,"agent":"0.2.0"}                   (ping)
//!
//! Handshake: the host pings before anything else and refuses an agent whose
//! `protocol` differs from its own (an agent without the field is protocol 1:
//! ping, pty, put, exec). The number lives in src/isolation/guest-protocol.json,
//! which the host CLI and this agent both read; bump it with any new op.
//!   {"t":"entries","e":[{"p":"a/b","k":"f","m":420,"s":3,"h":"<sha256>"}, ..]}  (list)
//!   {"t":"out","d":"<base64>"}                                (get, streamed)
//!
//! Secrets travel only inside `env` of an exec request, over vsock or the
//! container's stdio; they are never written to disk or put in argv.
//! Closing the connection kills the running step's process group.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_FRAME: usize = 64 * 1024 * 1024;

/// The wire protocol this agent speaks (shared with the host CLI).
fn protocol() -> u64 {
    let shared: serde_json::Value =
        serde_json::from_str(include_str!("../../src/isolation/guest-protocol.json")).unwrap_or_default();
    shared["protocol"].as_u64().unwrap_or(0)
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Request {
    Ping,
    Pty {
        argv: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        cwd: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
    },
    Put { path: String, mode: Option<u32>, content: String },
    List { root: String },
    Get { path: String },
    Exec {
        argv: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        cwd: Option<String>,
        timeout_ms: Option<u64>,
    },
}

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Reply<'a> {
    /// pty replies reuse Out/Exit; Exit carries the code.
    Out { d: &'a str },
    Err { d: &'a str },
    Exit { code: i32, timed_out: bool },
    Ok,
    /// The ping reply: `ok` (hosts that predate the handshake only look at `t`), plus versions.
    #[serde(rename = "ok")]
    Hello { protocol: u64, agent: &'static str },
    Error { message: String },
    Entries { e: Vec<Entry> },
}

/// One file-system entry under a sync root. `k`: `f` file, `d` directory, `l` symlink.
/// The host computes the same shape in src/isolation/sync.ts and compares field by field.
#[derive(Serialize)]
struct Entry {
    p: String,
    k: &'static str,
    m: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    s: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    h: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    t: Option<String>,
}

fn sha256_file(path: &std::path::Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Walk `root` without following symlinks; sockets, fifos and devices are skipped.
fn list_tree(root: &std::path::Path) -> std::io::Result<Vec<Entry>> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut names: Vec<_> = std::fs::read_dir(&dir)?.collect::<Result<_, _>>()?;
        names.sort_by_key(|e| e.file_name());
        for e in names {
            let path = e.path();
            let rel = path.strip_prefix(root).map_err(std::io::Error::other)?;
            let Ok(p) = std::str::from_utf8(rel.as_os_str().as_bytes()) else { continue };
            let md = std::fs::symlink_metadata(&path)?;
            let m = md.permissions().mode() & 0o7777;
            let ft = md.file_type();
            let entry = if ft.is_symlink() {
                let t = std::fs::read_link(&path)?;
                let Ok(t) = std::str::from_utf8(t.as_os_str().as_bytes()) else { continue };
                Entry { p: p.into(), k: "l", m: 0, s: None, h: None, t: Some(t.into()) }
            } else if ft.is_dir() {
                stack.push(path.clone());
                Entry { p: p.into(), k: "d", m, s: None, h: None, t: None }
            } else if ft.is_file() {
                Entry { p: p.into(), k: "f", m, s: Some(md.len()), h: Some(sha256_file(&path)?), t: None }
            } else {
                continue;
            };
            out.push(entry);
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum PtyIn {
    In { d: String },
    Resize { cols: u16, rows: u16 },
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0);
    for b in s.bytes() {
        if b == b'=' {
            break;
        }
        let v = B64.iter().position(|&x| x == b).ok_or("bad base64")? as u32;
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

trait Conn: Read + Write + Send {
    fn try_clone_box(&self) -> std::io::Result<Box<dyn Conn>>;
}

struct VsockConn(std::fs::File);
impl Read for VsockConn { fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> { self.0.read(b) } }
impl Write for VsockConn { fn write(&mut self, b: &[u8]) -> std::io::Result<usize> { self.0.write(b) } fn flush(&mut self) -> std::io::Result<()> { self.0.flush() } }
impl Conn for VsockConn {
    fn try_clone_box(&self) -> std::io::Result<Box<dyn Conn>> { Ok(Box::new(VsockConn(self.0.try_clone()?))) }
}

struct StdioConn;
impl Read for StdioConn { fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> { std::io::stdin().lock().read(b) } }
impl Write for StdioConn {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> { std::io::stdout().lock().write(b) }
    fn flush(&mut self) -> std::io::Result<()> { std::io::stdout().lock().flush() }
}
impl Conn for StdioConn { fn try_clone_box(&self) -> std::io::Result<Box<dyn Conn>> { Ok(Box::new(StdioConn)) } }

fn read_frame(r: &mut dyn Read) -> std::io::Result<Option<Vec<u8>>> {
    let mut h = [0u8; 4];
    match r.read_exact(&mut h) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_be_bytes(h) as usize;
    if n > MAX_FRAME {
        return Err(std::io::Error::other("frame too large"));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

fn send(w: &Mutex<Box<dyn Conn>>, reply: &Reply) -> std::io::Result<()> {
    let body = serde_json::to_vec(reply).map_err(std::io::Error::other)?;
    let mut w = w.lock().unwrap();
    w.write_all(&(body.len() as u32).to_be_bytes())?;
    w.write_all(&body)?;
    w.flush()
}

fn handle(mut conn: Box<dyn Conn>) {
    let frame = match read_frame(&mut conn) {
        Ok(Some(f)) => f,
        _ => return,
    };
    let req: Request = match serde_json::from_slice(&frame) {
        Ok(r) => r,
        Err(e) => {
            let w = Mutex::new(conn);
            let _ = send(&w, &Reply::Error { message: format!("bad request: {e}") });
            return;
        }
    };
    let mut reader = match conn.try_clone_box() {
        Ok(c) => c,
        Err(_) => return,
    };
    let w = Arc::new(Mutex::new(conn));
    match req {
        Request::Ping => {
            let _ = send(&w, &Reply::Hello { protocol: protocol(), agent: env!("CARGO_PKG_VERSION") });
        }
        Request::Pty { argv, env, cwd, cols, rows } => run_pty(w, reader, argv, env, cwd, cols, rows),
        Request::Put { path, mode, content } => {
            let res = b64_decode(&content).map_err(|e| e.to_string()).and_then(|bytes| {
                if let Some(p) = std::path::Path::new(&path).parent() {
                    std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
                std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode.unwrap_or(0o600))).map_err(|e| e.to_string())
            });
            let _ = send(&w, &match res { Ok(()) => Reply::Ok, Err(message) => Reply::Error { message } });
        }
        Request::List { root } => match list_tree(std::path::Path::new(&root)) {
            Ok(entries) => {
                let mut it = entries.into_iter().peekable();
                while it.peek().is_some() {
                    let chunk: Vec<Entry> = it.by_ref().take(512).collect();
                    if send(&w, &Reply::Entries { e: chunk }).is_err() {
                        return;
                    }
                }
                let _ = send(&w, &Reply::Ok);
            }
            Err(e) => {
                let _ = send(&w, &Reply::Error { message: format!("list {root}: {e}") });
            }
        },
        Request::Get { path } => {
            let res = std::fs::symlink_metadata(&path).and_then(|md| {
                if !md.file_type().is_file() {
                    return Err(std::io::Error::other("not a regular file"));
                }
                let mut f = std::fs::File::open(&path)?;
                let mut buf = vec![0u8; 1 << 16];
                loop {
                    let n = f.read(&mut buf)?;
                    if n == 0 {
                        return Ok(());
                    }
                    send(&w, &Reply::Out { d: &b64_encode(&buf[..n]) })?;
                }
            });
            let _ = send(&w, &match res { Ok(()) => Reply::Ok, Err(e) => Reply::Error { message: format!("get {path}: {e}") } });
        }
        Request::Exec { argv, env, cwd, timeout_ms } => {
            let Some(prog) = argv.first() else {
                let _ = send(&w, &Reply::Error { message: "empty argv".into() });
                return;
            };
            let mut cmd = Command::new(prog);
            cmd.args(&argv[1..])
                .env_clear()
                .envs(&env)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(c) = cwd {
                cmd.current_dir(c);
            }
            // Own process group so a timeout or a closed connection kills the whole tree.
            unsafe { cmd.pre_exec(|| { libc::setsid(); Ok(()) }); }
            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    let _ = send(&w, &Reply::Err { d: &b64_encode(format!("gild-guest-agent: cannot start {prog}: {e}\n").as_bytes()) });
                    let _ = send(&w, &Reply::Exit { code: 127, timed_out: false });
                    return;
                }
            };
            let pgid = child.id() as i32;
            let mut pumps = Vec::new();
            for (stream, is_err) in [
                (child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), false),
                (child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>), true),
            ] {
                let Some(mut s) = stream else { continue };
                let w = w.clone();
                pumps.push(std::thread::spawn(move || {
                    let mut buf = [0u8; 16384];
                    while let Ok(n) = s.read(&mut buf) {
                        if n == 0 { break }
                        let d = b64_encode(&buf[..n]);
                        let r = if is_err { Reply::Err { d: &d } } else { Reply::Out { d: &d } };
                        if send(&w, &r).is_err() { break }
                    }
                }));
            }
            // Host going away (cancel) = EOF on the connection: kill the group.
            let gone = Arc::new(std::sync::atomic::AtomicBool::new(false));
            {
                let gone = gone.clone();
                std::thread::spawn(move || {
                    let mut b = [0u8; 1];
                    loop {
                        match reader.read(&mut b) {
                            Ok(0) | Err(_) => { gone.store(true, std::sync::atomic::Ordering::SeqCst); break }
                            Ok(_) => {}
                        }
                    }
                });
            }
            let start = Instant::now();
            let limit = timeout_ms.map(Duration::from_millis);
            let mut timed_out = false;
            let code = loop {
                match child.try_wait() {
                    Ok(Some(st)) => break st.code().unwrap_or_else(|| {
                        use std::os::unix::process::ExitStatusExt;
                        128 + st.signal().unwrap_or(0)
                    }),
                    Ok(None) => {}
                    Err(_) => break 1,
                }
                let expired = limit.is_some_and(|l| start.elapsed() > l);
                if expired || gone.load(std::sync::atomic::Ordering::SeqCst) {
                    timed_out = expired;
                    unsafe { libc::kill(-pgid, libc::SIGKILL); }
                    let _ = child.wait();
                    break if expired { 124 } else { 130 };
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            // Leftover background processes must not outlive the step.
            unsafe { libc::kill(-pgid, libc::SIGKILL); }
            for p in pumps { let _ = p.join(); }
            let _ = send(&w, &Reply::Exit { code, timed_out });
        }
    }
}

fn find_program(prog: &str, env: &HashMap<String, String>) -> Option<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    let candidates: Vec<std::path::PathBuf> = if prog.contains('/') {
        vec![prog.into()]
    } else {
        env.get("PATH").map(String::as_str).unwrap_or("/usr/local/bin:/usr/bin:/bin")
            .split(':').map(|d| std::path::Path::new(d).join(prog)).collect()
    };
    candidates.into_iter().find(|c| c.is_file()).and_then(|c| std::ffi::CString::new(c.as_os_str().as_bytes()).ok())
}

/// Run argv on a fresh pty. Host frames: {"t":"in","d":b64} / {"t":"resize","cols","rows"}.
fn run_pty(
    w: Arc<Mutex<Box<dyn Conn>>>,
    mut reader: Box<dyn Conn>,
    argv: Vec<String>,
    env: HashMap<String, String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) {
    use std::ffi::CString;
    let Some(first) = argv.first() else {
        let _ = send(&w, &Reply::Error { message: "empty argv".into() });
        return;
    };
    let Some(program) = find_program(first, &env) else {
        let _ = send(&w, &Reply::Error { message: format!("cannot find {first}") });
        return;
    };
    // Everything the child needs is prepared before fork: no allocation after it.
    let c_argv: Vec<CString> = argv.iter().filter_map(|a| CString::new(a.as_str()).ok()).collect();
    let mut p_argv: Vec<*const libc::c_char> = c_argv.iter().map(|c| c.as_ptr()).collect();
    p_argv.push(std::ptr::null());
    let c_env: Vec<CString> = env.iter().filter_map(|(k, v)| CString::new(format!("{k}={v}")).ok()).collect();
    let mut p_env: Vec<*const libc::c_char> = c_env.iter().map(|c| c.as_ptr()).collect();
    p_env.push(std::ptr::null());
    let c_cwd = cwd.and_then(|c| CString::new(c).ok());
    let mut ws = libc::winsize { ws_row: rows.unwrap_or(24), ws_col: cols.unwrap_or(80), ws_xpixel: 0, ws_ypixel: 0 };
    let mut master: libc::c_int = -1;
    let pid = unsafe { libc::forkpty(&mut master, std::ptr::null_mut(), std::ptr::null_mut(), &raw mut ws) };
    if pid < 0 {
        let _ = send(&w, &Reply::Error { message: "forkpty failed".into() });
        return;
    }
    if pid == 0 {
        unsafe {
            if let Some(c) = &c_cwd { libc::chdir(c.as_ptr()); }
            libc::execve(program.as_ptr(), p_argv.as_ptr(), p_env.as_ptr());
            libc::_exit(127);
        }
    }
    // Host to pty.
    std::thread::spawn(move || {
        while let Ok(Some(frame)) = read_frame(&mut reader) {
            match serde_json::from_slice::<PtyIn>(&frame) {
                Ok(PtyIn::In { d }) => {
                    if let Ok(bytes) = b64_decode(&d) {
                        let mut off = 0;
                        while off < bytes.len() {
                            let n = unsafe { libc::write(master, bytes[off..].as_ptr() as *const _, bytes.len() - off) };
                            if n <= 0 { break }
                            off += n as usize;
                        }
                    }
                }
                Ok(PtyIn::Resize { cols, rows }) => unsafe {
                    let ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
                    libc::ioctl(master, libc::TIOCSWINSZ, &ws);
                },
                Err(_) => {}
            }
        }
        // Host went away: hang up the session.
        unsafe { libc::kill(-pid, libc::SIGHUP); libc::kill(pid, libc::SIGHUP); }
    });
    // pty to host, until the child closes the slave.
    let mut buf = [0u8; 16384];
    loop {
        let n = unsafe { libc::read(master, buf.as_mut_ptr() as *mut _, buf.len()) };
        if n <= 0 { break }
        if send(&w, &Reply::Out { d: &b64_encode(&buf[..n as usize]) }).is_err() { break }
    }
    let mut status = 0;
    unsafe { libc::waitpid(pid, &mut status, 0); }
    let code = if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 128 + libc::WTERMSIG(status) };
    let _ = send(&w, &Reply::Exit { code, timed_out: false });
}

#[cfg(not(target_os = "linux"))]
fn hook(_args: &[String]) {}

/// `gild-guest-agent hook --session ID [--agent A] [json]`: the hook command inside the guest.
/// Forwards the payload to the host over vsock (CID 2, port 9100); never fails the agent.
#[cfg(target_os = "linux")]
fn hook(args: &[String]) {
    #[repr(C)]
    struct SockaddrVm { family: u16, reserved: u16, port: u32, cid: u32, flags: u8, zero: [u8; 3] }
    let get = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let raw = match args.last() {
        Some(l) if l.starts_with('{') => l.clone(),
        _ => {
            let mut s = String::new();
            let _ = std::io::stdin().take(1 << 20).read_to_string(&mut s);
            s
        }
    };
    let msg = serde_json::json!({"op":"hook","session":get("--session"),"agent":get("--agent").unwrap_or_else(|| "claude".into()),"raw":raw});
    unsafe {
        let fd = libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM, 0);
        if fd < 0 { return }
        let tv = libc::timeval { tv_sec: 1, tv_usec: 0 };
        libc::setsockopt(fd, libc::SOL_SOCKET, libc::SO_SNDTIMEO, &tv as *const _ as *const _, std::mem::size_of::<libc::timeval>() as u32);
        let addr = SockaddrVm { family: libc::AF_VSOCK as u16, reserved: 0, port: 9100, cid: 2, flags: 0, zero: [0; 3] };
        if libc::connect(fd, &addr as *const _ as *const libc::sockaddr, std::mem::size_of::<SockaddrVm>() as u32) == 0 {
            use std::os::fd::FromRawFd;
            let mut f = std::fs::File::from_raw_fd(fd);
            let body = serde_json::to_vec(&msg).unwrap_or_default();
            let _ = f.write_all(&(body.len() as u32).to_be_bytes());
            let _ = f.write_all(&body);
        } else {
            libc::close(fd);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn vsock_listen(_port: u32) -> std::io::Result<i32> {
    Err(std::io::Error::other("vsock is only available inside a Linux guest"))
}

#[cfg(target_os = "linux")]
fn vsock_listen(port: u32) -> std::io::Result<i32> {
    #[repr(C)]
    struct SockaddrVm { family: u16, reserved: u16, port: u32, cid: u32, flags: u8, zero: [u8; 3] }
    unsafe {
        let fd = libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM, 0);
        if fd < 0 { return Err(std::io::Error::last_os_error()) }
        let addr = SockaddrVm { family: libc::AF_VSOCK as u16, reserved: 0, port, cid: libc::VMADDR_CID_ANY, flags: 0, zero: [0; 3] };
        if libc::bind(fd, &addr as *const _ as *const libc::sockaddr, std::mem::size_of::<SockaddrVm>() as u32) < 0
            || libc::listen(fd, 16) < 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(fd)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("hook") => hook(&args[2..]),
        Some("--stdio") => {
            // Host tier: `--shared` keeps everything the step creates readable and
            // writable by the group the runner user shares with this dedicated user.
            if args.get(2).map(String::as_str) == Some("--shared") {
                unsafe { libc::umask(0o007); }
            }
            handle(Box::new(StdioConn))
        }
        Some("--vsock") => {
            let port: u32 = args.get(2).and_then(|p| p.parse().ok()).unwrap_or(9002);
            let fd = match vsock_listen(port) {
                Ok(fd) => fd,
                Err(e) => { eprintln!("gild-guest-agent: vsock listen {port}: {e}"); std::process::exit(1) }
            };
            eprintln!("gild-guest-agent: listening on vsock {port}");
            loop {
                let c = unsafe { libc::accept(fd, std::ptr::null_mut(), std::ptr::null_mut()) };
                if c < 0 { continue }
                use std::os::fd::FromRawFd;
                let file = unsafe { std::fs::File::from_raw_fd(c) };
                std::thread::spawn(move || handle(Box::new(VsockConn(file))));
            }
        }
        _ => { eprintln!("usage: gild-guest-agent --vsock <port> | --stdio [--shared]"); std::process::exit(2) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_reply_carries_the_shared_protocol_number() {
        let reply = serde_json::to_value(Reply::Hello { protocol: protocol(), agent: env!("CARGO_PKG_VERSION") }).unwrap();
        let shared: serde_json::Value = serde_json::from_str(include_str!("../../src/isolation/guest-protocol.json")).unwrap();
        assert_eq!(reply["t"], "ok");
        assert_eq!(reply["protocol"], shared["protocol"]);
        assert!(protocol() >= 2);
    }

    #[test]
    fn base64_round_trips_binary() {
        for len in 0..40 {
            let data: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(b64_decode(&b64_encode(&data)).unwrap(), data);
        }
        assert_eq!(b64_encode(b"gild"), "Z2lsZA==");
        assert!(b64_decode("a$b").is_err());
    }

    #[test]
    fn lists_files_dirs_and_symlinks_without_following_links() {
        let root = std::env::temp_dir().join(format!("gga-list-{}", std::process::id()));
        std::fs::create_dir_all(root.join("d")).unwrap();
        std::fs::write(root.join("d/a.txt"), b"abc").unwrap();
        std::os::unix::fs::symlink("/etc", root.join("link")).unwrap();
        let entries = list_tree(&root).unwrap();
        let got: Vec<(String, &str)> = entries.iter().map(|e| (e.p.clone(), e.k)).collect();
        assert!(got.contains(&("d".into(), "d")));
        assert!(got.contains(&("d/a.txt".into(), "f")));
        assert!(got.contains(&("link".into(), "l")));
        let a = entries.iter().find(|e| e.p == "d/a.txt").unwrap();
        assert_eq!(a.h.as_deref(), Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
        assert_eq!(entries.iter().find(|e| e.p == "link").unwrap().t.as_deref(), Some("/etc"));
        assert!(!got.iter().any(|(p, _)| p.starts_with("link/")));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn finds_programs_on_the_given_path_only() {
        let env: HashMap<String, String> = [("PATH".to_string(), "/bin:/usr/bin".to_string())].into();
        assert!(find_program("sh", &env).is_some());
        assert!(find_program("definitely-not-a-program", &env).is_none());
    }
}
