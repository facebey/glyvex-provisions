# Lanzador de modelos

> **Idioma:** [English](LAUNCHER.md)

El lanzador (0.2.0+) arranca cualquier GGUF de tu librería de Provisions con
un clic — y es la pieza que une Provisions con
[Glyvex-AI-Suite](https://github.com/facebey/Glyvex-Group-AI-Suite-Open-Source).
A propósito no es un lanzador genérico: el comando de lanzamiento es mínimo,
las opciones avanzadas viven en la Suite y la configuración estructurada
vive en los presets.

## Engines (cascada)

El lanzador resuelve un engine en este orden, y podés fijar cualquiera de
ellos:

1. **Runtime gestionado de Glyvex-AI-Suite** — cuando la Suite está detectada
   en la máquina, Provisions reutiliza el propio `llama-server` probado de la
   Suite (localizado por un GLOB del pin de versión en la data dir de la
   Suite — nunca hardcodeado).
2. **Tu propio `llama-server`** — una ruta manual a cualquier binario de
   llama.cpp; el lanzador lo sondea (`--help`, `--version`,
   `--list-devices`) y descarta los flags que el build no conoce, así los
   builds viejos siguen funcionando.
3. **Ollama** — el modelo se pasa a Ollama (Modelfile desde el GGUF,
   `create`, luego `/api/chat` con `keep_alive -1`).

El probe también reporta el **inventario de devices** con el backend de
aceleración (CUDA/Vulkan/ROCm/SYCL/CPU) y advierte cuando solo hay CPU.

## Perfiles

Un perfil por régimen, en espejo del semáforo:

| Perfil | Cuándo | Qué hace |
|---|---|---|
| `gpu` | verde en una sola GPU | offload completo (`-ngl` alto) |
| `multi` | varias GPUs, la suma de VRAM alcanza | `-ngl` alto + `--tensor-split` entre las GPUs |
| `offload` | entra parcialmente | un `-ngl` intermedio (CPU+GPU) |
| `cpu` | no entra nada | CPU pura |

El comando de lanzamiento se mantiene mínimo: `-m -c -ngl -host -port`
(+ `--tensor-split` en `multi`, + `--mmproj` para visión). Si un lanzamiento
falla, la causa es inequívoca — "no cabe", no "un flag quedó mal".

## Visión y argumentos avanzados

- **Visión**: asociá un archivo `mmproj` de la librería del modelo (o una
  ruta manual). Los guards rechazan un archivo inexistente; Ollama rechaza
  mmproj externo (422).
- **Argumentos extra**: `extra_args` libres para los casos raros que
  necesitan algo que los perfiles no cubren.

## Presets

`data/presets.json` guarda configuraciones de lanzamiento nombradas por
escenario (chat / visión / offload). Un preset describe **cómo** lanzar —
engine, perfil, contexto, mmproj, args extra — y **nunca qué modelo**, así
el mismo preset aplica a cualquier archivo de la librería. CRUD completo
desde la UI.

## Integración con la Suite

Cuando la Suite está detectada (su API pública responde):

- **"Registrar en la Suite"** — una acción explícita, con confirmación (una
  acción entre apps nunca es automática): la Suite persiste el modelo vía su
  API pública y lo muestra en su Launcher sin re-scan.
- **"Abrir la Suite"** — la abre en el acto.

Regla dura: **Provisions NUNCA escribe archivos de la Suite.** Toda la
integración es sobre la API HTTP pública de la Suite; el único contacto de
filesystem es *leer* el binario del runtime gestionado de la Suite. Sin
Suite, el lanzador funciona igual en pie: lanzar, verificar, dejar el
servidor corriendo (otras máquinas de tu red pueden usar su puerto) o
detenerlo.

## Verificación y sesión

Una sesión a la vez. Tras lanzar, la app verifica el servidor — endpoint de
health → `/v1/models` → un ping de chat streaming — y muestra **TTFB, tok/s
y un snapshot de VRAM**, más el log vivo del servidor streamed en el panel.
