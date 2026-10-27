//! Shell Tauri de Glyvex Provisions (U7) — espejo del patrón de Glyvex-AI-Suite.
//!
//! Ciclo de vida del sidecar (adaptado de `src-tauri/src/lib.rs` de la Suite):
//! 1. Si ya hay un backend asentado en la escalera 8321..8330 (flujo dev con
//!    `start.ps1`) se REUTILIZA: no se duplica el proceso.
//! 2. Si no, lo spawn-ea: en dev con el python del `.venv` (`-m app.main`,
//!    cwd = raíz del repo); en producción con el sidecar PyInstaller empaquetado
//!    como resource (`provisions-backend/provisions-backend.exe`).
//! 3. Drena su stdout en un hilo (no bloquear a uvicorn escribiendo logs) y
//!    captura el marcador `#PORT_ASSIGNED:<puerto>#`.
//! 4. Poll de `/api/healthz` (ureq, sin reqwest/tokio) hasta 120 s, con hasta
//!    3 intentos de spawn.
//! 5. Emite `sidecar-state {state, url, port}` con heartbeat cada 5 s (la
//!    webview puede cargar tarde) hasta que el sidecar muere → reintento.
//! 6. En `RunEvent::Exit` mata al sidecar propio (los reutilizados del flujo
//!    dev se dejan vivos, que es lo que hizo el usuario con start.ps1).
//!
//! La redirección de la webview a `url` la hace el frontend (web/src/tauri.ts)
//! al recibir `sidecar-state`, igual que la Suite: el puerto final puede no ser
//! 8321 (escalera), así que la shell no hardcodea el origen.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, RunEvent};

/// Escalera del backend (decisión §7.10): preferido 8321 + vecinos.
const LADDER: u16 = 8330 - 8321 + 1;
const BASE_PORT: u16 = 8321;

/// Hijo spawn-eado por NOSOTROS (reused no se guarda: no lo matamos).
static CHILD: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Clone, Serialize)]
struct SidecarState {
    state: &'static str, // "running" | "stopped"
    port: u16,
    url: String,
}

fn emit_state(app: &AppHandle, state: &'static str, port: u16) {
    let _ = app.emit(
        "sidecar-state",
        SidecarState {
            state,
            port,
            url: format!("http://127.0.0.1:{port}"),
        },
    );
}

fn health_ok(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/api/healthz");
    matches!(ureq::get(&url).timeout(Duration::from_secs(2)).call(), Ok(r) if r.status() == 200)
}

fn find_existing_backend() -> Option<u16> {
    (BASE_PORT..BASE_PORT + LADDER).find(|p| health_ok(*p))
}

/// Mismo contrato que la Suite: línea exacta `#PORT_ASSIGNED:<puerto>#`.
fn parse_port_marker(line: &str) -> Option<u16> {
    let rest = line.trim().strip_prefix("#PORT_ASSIGNED:")?;
    let digits = rest.split('#').next()?;
    digits.trim().parse().ok()
}

/// Resuelve qué binario lanzar según el modo.
/// Orden: env `PROV_BACKEND_EXE` → resource empaquetado (producción) →
/// `.venv` del repo (solo builds de dev).
fn backend_command(app: &AppHandle) -> Option<(String, Vec<String>, Option<PathBuf>)> {
    if let Ok(exe) = std::env::var("PROV_BACKEND_EXE") {
        return Some((exe, vec![], None));
    }
    if let Ok(dir) = app.path().resource_dir() {
        // Tauri coloca los resources bajo resource_dir() manteniendo el nombre
        // del entry; se aceptan ambas variantes (con y sin prefijo resources/),
        // igual que la Suite.
        for parts in [&["provisions-backend"][..], &["resources", "provisions-backend"][..]] {
            let mut p = dir.clone();
            for part in parts {
                p = p.join(part);
            }
            let exe = p.join("provisions-backend.exe");
            if exe.exists() {
                return Some((exe.to_string_lossy().into_owned(), vec![], None));
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        // dev: el binario está en src-tauri/target/debug/ → la raíz del repo
        // es 4 niveles arriba (debug→target→src-tauri→web→root).
        let exe = std::env::current_exe().ok()?;
        let mut dir = exe.parent()?;
        for _ in 0..4 {
            dir = dir.parent()?;
        }
        let py = dir.join(".venv").join("Scripts").join("python.exe");
        if py.exists() {
            return Some((
                py.to_string_lossy().into_owned(),
                vec!["-m".into(), "app.main".into()],
                Some(dir.to_path_buf()),
            ));
        }
    }
    None
}

/// Spawn + espera del marker + poll de health. Devuelve el puerto confirmado y
/// deja el hijo en CHILD.
fn spawn_and_wait(app: &AppHandle) -> Option<u16> {
    let (program, args, cwd) = backend_command(app)?;
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    if let Some(c) = &cwd {
        cmd.current_dir(c);
    }
    cmd.env("PROV_HOST", "127.0.0.1")
        // El console_hook del sidecar conserva la pipe de stdout solo con esta
        // variable (patrón GLYVEX_STDOUT_PIPE de la Suite): si no, el marker
        // se iría al log y Rust no lo vería.
        .env("PROV_STDOUT_PIPE", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    let stdout = child.stdout.take()?;

    // Hilo drenador: lee stdout SIEMPRE (si el pipe se llena, uvicorn se
    // bloquea escribiendo sus logs) y reenvía el puerto del marker.
    let (tx, rx) = mpsc::channel::<Option<u16>>();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(None); // pipe cerrado: sidecar murió
                    break;
                }
                Ok(_) => {
                    if let Some(p) = parse_port_marker(&line) {
                        let _ = tx.send(Some(p));
                    }
                }
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(120);
    let mut marker_port: Option<u16> = None;
    while Instant::now() < deadline {
        if let Ok(Some(p)) = rx.try_recv() {
            marker_port = Some(p);
        }
        // Con marker usamos ese puerto; sin él (o antes de que llegue), la
        // escalera: el backend ya está bound en alguno de los vecinos.
        let candidate = marker_port.or_else(find_existing_backend);
        if let Some(p) = candidate {
            if health_ok(p) {
                *CHILD.lock().unwrap() = Some(child);
                return Some(p);
            }
        }
        if child.try_wait().ok().flatten().is_some() {
            break; // murió antes de subir
        }
        thread::sleep(Duration::from_secs(1));
    }
    let _ = child.kill();
    let _ = child.wait();
    let _ = app;
    None
}

/// Heartbeat `running` cada 5 s mientras el hijo propio esté vivo.
fn monitor_owned(app: &AppHandle, port: u16) {
    loop {
        emit_state(app, "running", port);
        let dead = {
            let mut guard = CHILD.lock().unwrap();
            match guard.as_mut() {
                None => true,
                Some(ch) => match ch.try_wait() {
                    Ok(None) => false,
                    _ => {
                        *guard = None;
                        true
                    }
                },
            }
        };
        if dead {
            return;
        }
        thread::sleep(Duration::from_secs(5));
    }
}

/// Backend REUTILIZADO (dev con start.ps1): no lo poseemos; solo vigilamos su
/// health para reintentar spawn si desaparece.
fn monitor_reused(app: &AppHandle, port: u16) {
    while health_ok(port) {
        emit_state(app, "running", port);
        thread::sleep(Duration::from_secs(5));
    }
}

fn run_lifecycle(app: AppHandle) {
    let mut attempts = 0;
    loop {
        if let Some(port) = find_existing_backend() {
            monitor_reused(&app, port);
            // el backend ajeno desapareció → se intenta levantar propio
        }
        attempts += 1;
        if attempts > 3 {
            emit_state(&app, "stopped", BASE_PORT);
            return;
        }
        match spawn_and_wait(&app) {
            Some(port) => {
                monitor_owned(&app, port);
                emit_state(&app, "stopped", port);
            }
            None => {
                emit_state(&app, "stopped", BASE_PORT);
            }
        }
        thread::sleep(Duration::from_secs(2));
    }
}

fn kill_child() {
    let mut guard = CHILD.lock().unwrap();
    if let Some(mut ch) = guard.take() {
        let _ = ch.kill();
        let _ = ch.wait();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        // process:allow-restart (capabilities) lo usa el updater tras instalar;
        // sin el plugin registrado el build rechaza esa permission.
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle().clone();
            thread::spawn(move || run_lifecycle(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Glyvex Provisions");
    app.run(|_app, event| {
        if let RunEvent::Exit = event {
            kill_child();
        }
    });
}
