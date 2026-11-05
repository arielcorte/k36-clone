<img src="assets/icon.svg" width="64" height="64" alt="">

# k36-clone

Herramientas para la consola portátil **K36 clon** (Allwinner A33) que viene con **Batocera 42** de fábrica.

## Cargador de juegos (web)

**https://k36.arielcorte.com**: página para agregar y quitar juegos de la tarjeta SD desde Windows, poner carátulas y datos (como el scraper de Batocera, sin necesidad de Wi-Fi en la consola), traducir las descripciones al español y respaldar partidas. Funciona en Chrome o Edge y no instala nada: usa la File System Access API sobre la partición `GAMES` (FAT32) de la tarjeta. El código está en [`docs/`](docs/).

Las carátulas salen de [libretro-database](https://github.com/libretro/libretro-database) y [libretro-thumbnails](https://github.com/libretro-thumbnails), y las descripciones de Wikipedia. Se guardan en `images/` y `gamelist.xml` con los mismos nombres que usa EmulationStation de Batocera.

Funciona con cualquier Batocera configurado para tomar `roms/` (y opcionalmente `saves/`) de una partición FAT32, con `sharedevice=DEVICES` en `batocera-boot.conf`. La explicación completa está en la página.

## Scripts (Linux, necesitan `sudo`)

| Script | Qué hace |
|---|---|
| `scripts/move-saves-to-games.sh` | Agrega `sharedevice_part4=SAVES@/dev/mmcblk0p7:saves` y copia las partidas a `GAMES/saves`, para que Windows pueda respaldarlas. |
| `scripts/check-real-capacity.sh` | Detecta tarjetas SD falsas (que dicen tener más capacidad de la real). |
| `scripts/1-read-original.sh`, `scripts/2-write-125gb.sh` | Clonan el sistema de la tarjeta original a una tarjeta más grande y agrandan `GAMES`. |
| `scripts/grow-games-125gb.sh` | Agranda la partición `GAMES` hasta ocupar toda la tarjeta. |

Los scripts verifican el tamaño y las etiquetas de la tarjeta antes de escribir, pero revisalos y ajustalos a tu tarjeta antes de usarlos.

## Por qué no ArkOS

ArkOS solo funciona en chips Rockchip (RK3326/RK3566). Esta K36 clon usa un Allwinner A33 de 32 bits, así que el Batocera del fabricante es el único sistema que la soporta.
