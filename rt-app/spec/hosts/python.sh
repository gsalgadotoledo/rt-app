#!/bin/sh
# Run Python >= 3.11 with the RT-App Python packages (core-python/src) on the path.
here=$(cd "$(dirname "$0")" && pwd)
export PYTHONPATH="$here/../../core-python/src${PYTHONPATH:+:$PYTHONPATH}"
# The project virtual environment (optional dependencies: cryptography, psycopg, boto3) comes first.
venv="$here/../../core-python/.venv/bin/python"
[ -x "$venv" ] && [ -z "$RT_APP_PYTHON" ] && exec "$venv" "$@"
for candidate in "$RT_APP_PYTHON" python3.14 python3.13 python3.12 python3.11 python3; do
  [ -n "$candidate" ] || continue
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
    exec "$candidate" "$@"
  fi
done
echo "Python 3.11 or newer is required (set RT_APP_PYTHON)" >&2
exit 1
