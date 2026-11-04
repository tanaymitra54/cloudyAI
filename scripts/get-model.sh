#!/usr/bin/env bash
# Download the CloudyVoice model (whisper.cpp GGML) into ~/.cache/cloudyvoice.
# Usage: npm run get-model            -> base.en (~142 MB, default)
#        npm run get-model -- small   -> small.en (~466 MB, more accurate)
#        npm run get-model -- tiny    -> tiny.en  (~75 MB, fastest)
set -euo pipefail

SIZE="${1:-base}"
DIR="${HOME}/.cache/cloudyvoice"
FILE="ggml-${SIZE}.en.bin"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${FILE}"

mkdir -p "$DIR"

if [ -f "${DIR}/${FILE}" ]; then
  echo "CloudyVoice model already present: ${DIR}/${FILE}"
  exit 0
fi

echo "Downloading ${FILE} -> ${DIR}"
curl -fL --progress-bar -o "${DIR}/${FILE}" "$URL"
echo "Done: ${DIR}/${FILE}"
