#!/usr/bin/env bash
# Backend of the devtool environment storing the files on any storage rclone reaches (Google Drive,
# Dropbox, OneDrive, WebDAV, Backblaze B2...), under the remote folder given by $REMOTE, such as
# `myremote:dev-environment`. Needs rclone 1.63 or later, configured with `rclone config`, and jq.
# A download writes straight into the file the devtool gives, so the devtool sees it grow.
#
# Usage: rclone.sh list
#        rclone.sh download <path> <file>
#        rclone.sh upload <path> <file>
#        rclone.sh remove <path>
set -euo pipefail

: "${REMOTE:?set REMOTE to the rclone remote folder, such as myremote:dev-environment}"

list () {
  rclone mkdir "$REMOTE" || true
  rclone lsjson -R --files-only --hash "$REMOTE" \
    | jq '{ files: [ .[] | { path: .Path, size: .Size, updatedAt: .ModTime, version: (((.Hashes // {}) | to_entries | first | .value) // "\(.ModTime)-\(.Size)") } ] }'
}

download () {
  if ! rclone lsf "$REMOTE/$1" >/dev/null 2>&1 || [ -z "$(rclone lsf "$REMOTE/$1")" ]; then
    exit 2
  fi
  rclone copyto --inplace "$REMOTE/$1" "$2"
}

upload () {
  rclone copyto "$2" "$REMOTE/$1"
}

remove () {
  rclone deletefile "$REMOTE/$1" 2>/dev/null || true
}

case "${1:-}" in
  list) list ;;
  download) download "$2" "$3" ;;
  upload) upload "$2" "$3" ;;
  remove) remove "$2" ;;
  *) echo "usage: $0 list | download <path> <file> | upload <path> <file> | remove <path>" >&2; exit 1 ;;
esac
