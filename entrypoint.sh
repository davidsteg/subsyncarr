#!/bin/bash
set -e

# Run as PUID:PGID so synced subtitles keep the media library's ownership.
PUID=${PUID:-1000}
PGID=${PGID:-1000}

if [ "$(id -u subsyncarr)" != "$PUID" ] || [ "$(id -g subsyncarr)" != "$PGID" ]; then
  groupmod -o -g "$PGID" subsyncarr
  usermod -o -u "$PUID" subsyncarr
  chown -R subsyncarr:subsyncarr /home/subsyncarr
fi

# /app/data is a mounted volume with unpredictable ownership.
chown -R subsyncarr:subsyncarr /app/data

exec gosu subsyncarr "$@"
