# ARKA Meet — app de escritorio (macOS)

Ventana nativa sobre `meet.arkaltd.io`, como la app de Zoom: ícono en el Dock,
ventana propia, permisos de cámara/micrófono del sistema. Deliberadamente
delgada — el producto vive en Vercel, así que **actualizar la app web actualiza
también esta app** sin recompilar nada.

## Construir el instalador (DMG)

Requiere Node en la máquina que compila (la tuya):

```bash
npm install
npm run build:mac
```

Sale en `dist/ARKA Meet-0.1.0-arm64.dmg` (Apple Silicon) y `-x64` (Intel).

La firma es **ad-hoc** (`identity: null`): gratis, sin cuenta de Apple
Developer, tal como quedó decidido en la spec (sección 9).

## Instalar (lo que le decís a tus socios)

1. Abrir el DMG y arrastrar **ARKA Meet** a Aplicaciones.
2. Al abrirla la primera vez, macOS la va a bloquear por no estar notarizada.
   **Es esperado**: Ajustes del Sistema → Privacidad y Seguridad → abajo
   aparece "ARKA Meet fue bloqueada" → **Abrir de todos modos**. Una sola vez
   por Mac.
3. Aceptar los permisos de cámara y micrófono cuando el sistema los pida.

> Nota: desde macOS Sequoia ya no existe el atajo de Control-clic → Abrir;
> el paso por Ajustes es el único camino. Si algún día se quiere eliminar esa
> fricción, la salida es la cuenta de Apple Developer ($99/año) + notarización.

## Qué hace el wrapper (y qué no)

- Auto-concede los permisos web de cámara/pantalla **solo** para
  `meet.arkaltd.io` y `video.arkaltd.io`; el permiso real del sistema (TCC)
  sigue mandando.
- Links externos (Google Calendar, etc.) abren en el navegador.
- No guarda estado, no tiene lógica de actualización, no embebe nada del
  producto.

## Pendiente natural (Fase 8)

Cuando exista la señalización de llamadas, este wrapper es donde vive la
"tarjeta de llamada entrante" nativa tipo Zoom (ventana always-on-top),
escuchando el mismo WebSocket que la PWA — ver spec sección 10.3.
