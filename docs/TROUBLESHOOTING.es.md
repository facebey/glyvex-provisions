# Solución de problemas — casos comunes

> **Idioma:** [English](TROUBLESHOOTING.md)

Casos reales con el diagnóstico detrás. Todos verificados en vivo.

## La app arranca lenta (20+ s de doble-clic a UI usable)

**Síntoma.** El splash se queda ~20–24 s antes de que aparezca la UI.

**Qué pasa.** Se midieron y corrigieron dos causas, y una puede seguir
viviendo en tu máquina:

1. **Código (corregido en 0.2.1)**: la shell sondeaba la escalera 8321–8330
   *secuencialmente* (diez sondeos uno detrás de otro, 2 s de timeout
   c/u). Sumado a eso, el stack de red se importaba todo en el arranque. La
   0.2.1 hizo la sonda en paralelo (un hilo por puerto) y los imports
   diferidos: el arranque bajó de 22,7 s a 4,0 s **en una máquina que
   todavía tenía la causa 3**.
2. **Otro backend de Provisions ya corriendo**: la app lo reutiliza por
   diseño (es una feature para múltiples instancias), así que "lento para
   abrir" puede ser simplemente el redirect a un puerto vecino sano.
   Revisá `Get-NetTCPConnection -LocalPort 8321..8330` (o mirá en qué puerto
   abrió la UI).
3. **Máquina (puede seguir aplicando)**: una anomalía del stack TCP de
   Windows donde un SYN a un puerto de loopback *cerrado* tarda ~2 s en
   fallar en vez de <10 ms (el RST no vuelve y el stack espera la
   retransmisión). Hasta que se repare, cada sonda cuesta ~2 s aunque sea en
   paralelo.

**Qué hacer.**
- Actualizá a 0.2.1 o mayor (el banner in-app lo hace, o reinstalá desde
  [Releases](https://github.com/facebey/glyvex-provisions/releases/latest)).
- Reparar el stack TCP: en una consola **de administrador**, ejecutá
  `netsh winsock reset` y `netsh int tcp reset`, y **reiniciá**. Después, un
  puerto de loopback cerrado falla en <10 ms y el arranque baja a
  ~1,5–2 s.
- Si sigue lenta después de eso: el sidecar en sí es rápido (healthz en
  1–2 s medido), así que leé `sidecar-stderr.log` (abajo) antes de
  reportar.

## La búsqueda falla con 401/403 en un repo de Hugging Face

**Síntoma.** Mensaje amigable: el repo es gated (privado o con acceso
restringido).

**Qué pasa.** Los repos gated exigen que la cuenta de Hugging Face haya
aceptado las condiciones de acceso del repo (a menudo un formulario de
licencia en la página del repo), y las llamadas por API necesitan un token
con ese acceso.

**Qué hacer.** Abrí el repo en huggingface.co con tu cuenta, aceptá los
términos de acceso, y asegurá que la app use un `HF_TOKEN` /
`huggingface_hub` logueado con un token que lleve ese acceso. Los repos
públicos no necesitan nada de esto.

## La UI abre en un puerto que no es 8321

**Síntoma.** La app funciona, pero la barra de direcciones / la red muestra
8322–8330 o un puerto aleatorio alto.

**Qué pasa.** Es la escalera de puertos haciendo su trabajo: 8321 estaba
ocupado (otro proceso, o otra instancia de Provisions), así que el backend
tomó el vecino libre — o, si la escalera entera está ocupada, un puerto
asignado por el SO. El marcador `#PORT_ASSIGNED:<puerto>#` es lo que le dice
a la shell dónde está el backend de verdad.

**Qué hacer.** Nada — es por diseño. Si querés recuperar el 8321, encontrá
qué lo tiene (`Get-NetTCPConnection -LocalPort 8321`) y liberalo. Nota:
recién después de matar al proceso que tenía el 8321, el puerto puede
quedar "ocupado" unos segundos (OwningProcess 0 — el kernel liberándolo);
esperá ~3 s antes de re-verificar.

## El splash dice "El backend no arrancó. Reintentando…"

**Síntoma.** La app nunca llega a la UI y se queda en el loop del retry.

**Qué pasa.** El proceso del sidecar murió antes de poder imprimir su
marcador de puerto. La causa casi siempre está en el stderr del sidecar, que
la shell drena a un log.

**Qué hacer.** Abrí
`%LOCALAPPDATA%\glyvex-provisions\data\logs\sidecar-stderr.log` (instalada)
— contiene el traceback de Python. Causas comunes: el core `hf_down` sin
instalar en el venv (dev), una data dir corrupta, o una desviación de
versiones de dependencias. En dev, corre el backend a mano
(`uvicorn app.main:app --host 127.0.0.1 --port 8321`) para ver el error en
la consola. También podés apuntar la app a otra data dir con `PROV_DATA_DIR`
para descartar una corrupta.

## El botón "Actualizar y reiniciar" falló en una instalación vieja (401/ACL)

**Síntoma.** En 0.1.0 o 0.1.1, el botón de actualizar fallaba con
`Command stop_sidecar not allowed by ACL`.

**Qué pasa.** En Tauri v2 todo comando IPC pasa el chequeo ACL de la
ventana, incluidos los comandos que la app define en sí. El fix (la
permission custom `sidecar-control`) salió en **0.1.2**.

**Qué hacer.** Las 0.1.0/0.1.1 pueden chequear el feed pero no completar el
flujo in-app: instalá 0.1.2+ a mano desde Releases una vez, y todas las
actualizaciones posteriores funcionan in-app.

## La carpeta de destino fue rechazada (422)

**Síntoma.** El flujo de búsqueda/descarga rechaza la carpeta elegida.

**Qué pasa.** La carpeta se valida antes de cualquier descarga: debe existir
y ser un disco local, share de NAS o UNC escribible.

**Qué hacer.** Creá la carpeta, chequeá permisos (la app corre por-usuario,
sin admin) y elegí un camino dentro de un volumen donde el usuario pueda
escribir.

## "Se me fueron los modelos" después de una reinstalación

**Qué pasa.** No se fueron. Los datos del usuario viven en
`%LOCALAPPDATA%\glyvex-provisions\data` (índice de librería, perfiles,
presets, settings, logs), y el instalador NSIS nunca lo toca.

**Qué hacer.** Nada — apuntá la app a la misma carpeta de destino que
usabas (el índice de librería referencia los archivos en disco). Si la data
dir en sí se movió, fijá `PROV_DATA_DIR` en su nueva ubicación.

## ¿Sigue atascado?

Reportalo en los [issues del repo](https://github.com/facebey/glyvex-provisions/issues)
con: versión, el puerto donde abrió la UI, y el contenido de
`sidecar-stderr.log` (redactá rutas si querés). Los problemas de seguridad
van por los canales de [SECURITY.md](../SECURITY.es.md), nunca un issue
público.
