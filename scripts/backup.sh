#!/usr/bin/env bash
# Empaqueta ./data en un .tar.gz con la fecha en el nombre y conserva solo los 14 más
# recientes en el directorio de destino (borra los más viejos).
#
# AVISO: el archivo generado contiene TODOS los perfiles, sus passkeys públicas, su historial
# de entrenamiento y, si AUDIT_LOG está activo, audit.log con las horas de inicio de sesión de
# todo el mundo. Piénsalo dos veces antes de subir esto a un servicio de backup que no gestionas
# tú (Dropbox, un NAS de terceros, etc.) sin cifrarlo antes.
#
# Uso:
#   ./scripts/backup.sh [directorio_destino]
#   directorio_destino por defecto: ./backups
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP=14
DEST="${1:-backups}"

if [ ! -d data ]; then
  echo "✗ No existe ./data — nada que respaldar. ¿Estás en la raíz del proyecto y ya arrancaste el servidor al menos una vez?" >&2
  exit 1
fi

mkdir -p "$DEST"

stamp="$(date +%F_%H%M%S)"
archive="$DEST/opengym-backup-$stamp.tar.gz"

tar czf "$archive" data/
echo "✓ Backup creado: $archive"

# Conserva solo los KEEP más recientes y borra el resto. El orden lo da `ls -1t`: fecha de
# modificación, más reciente primero — no el nombre. Si alguna vez restauras un backup viejo y el
# fichero vuelve a tocarse, lo que importa es cuál es de verdad el más nuevo en disco.
count=0
# Los nombres los genera este script y nunca llevan espacios, así que el troceado por palabras
# del $(...) es seguro y no hace falta -print0.
for f in $(ls -1t "$DEST"/opengym-backup-*.tar.gz 2>/dev/null); do
  count=$((count + 1))
  if [ "$count" -gt "$KEEP" ]; then
    rm -f "$f"
    echo "  borrado (más viejo que los últimos $KEEP): $f"
  fi
done

echo "✓ Quedan $(ls -1 "$DEST"/opengym-backup-*.tar.gz 2>/dev/null | wc -l) backups en $DEST (máx. $KEEP)."
