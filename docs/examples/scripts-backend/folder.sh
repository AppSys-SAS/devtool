#!/usr/bin/env bash
# Backend of the devtool environment storing the files in a folder: a shared or mounted folder (NFS,
# SMB, a synchronized drive) given by $ROOT.
#
# Usage: folder.sh list
#        folder.sh download <path> <file>
#        folder.sh upload <path> <file>
#        folder.sh remove <path>
set -euo pipefail

: "${ROOT:?set ROOT to the folder holding the files}"

# Prints a text as a JSON string.
json_string () {
  local text=$1
  text=${text//\\/\\\\}
  text=${text//\"/\\\"}
  text=${text//$'\t'/\\t}
  text=${text//$'\n'/\\n}
  text=${text//$'\r'/\\r}
  printf '"%s"' "$text"
}

# Prints "<size> <modification time in seconds>" of a file, on macOS and on Linux.
size_and_mtime () {
  if stat -c '%s %Y' "$1" >/dev/null 2>&1; then
    stat -c '%s %Y' "$1"
  else
    stat -f '%z %m' "$1"
  fi
}

# Prints a time in seconds since the epoch as ISO 8601 UTC, on macOS and on Linux.
iso_date () {
  if date -u -d "@$1" '+%Y-%m-%dT%H:%M:%SZ' >/dev/null 2>&1; then
    date -u -d "@$1" '+%Y-%m-%dT%H:%M:%SZ'
  else
    date -u -r "$1" '+%Y-%m-%dT%H:%M:%SZ'
  fi
}

# Refuses a path leaving the root folder.
check_path () {
  case "/$1/" in
    */../*|*/./*|//*) echo "invalid path: $1" >&2; exit 1 ;;
  esac
}

list () {
  local separator='' file relative size mtime
  printf '{"files":['
  if [ -d "$ROOT" ]; then
    while IFS= read -r -d '' file; do
      relative=${file#"$ROOT"/}
      case "$relative" in *.part) continue ;; esac
      read -r size mtime < <(size_and_mtime "$file")
      printf '%s{"path":%s,"size":%s,"updatedAt":"%s","version":"%s-%s"}' \
        "$separator" "$(json_string "$relative")" "$size" "$(iso_date "$mtime")" "$mtime" "$size"
      separator=','
    done < <(find "$ROOT" -type f -print0)
  fi
  printf ']}\n'
}

download () {
  check_path "$1"
  if [ ! -f "$ROOT/$1" ]; then
    exit 2
  fi
  cp "$ROOT/$1" "$2"
}

upload () {
  check_path "$1"
  mkdir -p "$(dirname "$ROOT/$1")"
  cp "$2" "$ROOT/$1.part"
  mv -f "$ROOT/$1.part" "$ROOT/$1"
}

remove () {
  check_path "$1"
  rm -f "$ROOT/$1"
}

case "${1:-}" in
  list) list ;;
  download) download "$2" "$3" ;;
  upload) upload "$2" "$3" ;;
  remove) remove "$2" ;;
  *) echo "usage: $0 list | download <path> <file> | upload <path> <file> | remove <path>" >&2; exit 1 ;;
esac
