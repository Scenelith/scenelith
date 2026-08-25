#!/bin/sh

set -eu

REPOSITORY="Scenelith/scenelith"
ASSET_NAME="scenelith-selfhost.tar.gz"
INSTALL_DIRECTORY=${SCENELITH_INSTALL_DIR:-"$PWD/scenelith"}
REQUESTED_VERSION=${SCENELITH_VERSION:-latest}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

download() {
  url=$1
  destination=$2
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location "$url" --output "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$destination"
  else
    die "Installation requires curl or wget."
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

case "$REQUESTED_VERSION" in
  latest) release_path=latest/download ;;
  *)
    REQUESTED_VERSION=${REQUESTED_VERSION#v}
    printf '%s\n' "$REQUESTED_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "SCENELITH_VERSION must look like 1.2.3"
    release_path="download/v$REQUESTED_VERSION"
    ;;
esac

[ "$INSTALL_DIRECTORY" != / ] || die "Refusing to install into /"
if [ -d "$INSTALL_DIRECTORY" ] && [ -n "$(find "$INSTALL_DIRECTORY" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  die "Installation directory is not empty: $INSTALL_DIRECTORY"
fi

temporary=$(mktemp -d "${TMPDIR:-/tmp}/scenelith-install.XXXXXX")
trap 'rm -rf "$temporary"' 0 HUP INT TERM
base_url="https://github.com/$REPOSITORY/releases/$release_path"

printf 'Downloading the Scenelith self-hosted release...\n'
download "$base_url/$ASSET_NAME" "$temporary/$ASSET_NAME"
download "$base_url/$ASSET_NAME.sha256" "$temporary/$ASSET_NAME.sha256"
expected=$(awk 'NR == 1 { print $1 }' "$temporary/$ASSET_NAME.sha256")
case "$expected" in *[!a-fA-F0-9]*|'') die "Release checksum is invalid" ;; esac
[ "$(sha256_file "$temporary/$ASSET_NAME")" = "$expected" ] || die "Release bundle checksum mismatch"

unsafe=$(tar -tzf "$temporary/$ASSET_NAME" | awk '/^\// || /(^|\/)\.\.($|\/)/ { print; exit }')
[ -z "$unsafe" ] || die "Release archive contains an unsafe path: $unsafe"
tar -xzf "$temporary/$ASSET_NAME" -C "$temporary"
bundle="$temporary/scenelith-selfhost"
[ -f "$bundle/MANIFEST.sha256" ] || die "Release bundle has no integrity manifest"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$bundle" && sha256sum -c MANIFEST.sha256 >/dev/null)
else
  (cd "$bundle" && shasum -a 256 -c MANIFEST.sha256 >/dev/null)
fi

mkdir -p "$INSTALL_DIRECTORY"
for path in \
  scenelith \
  README.md \
  LICENSE.md \
  docs/SELF_HOSTING.md \
  config/runtime-providers.json \
  deploy/compose/runtime.yaml \
  deploy/selfhost/.env.example \
  deploy/selfhost/Caddyfile \
  deploy/selfhost/compose.yaml \
  deploy/selfhost/runtime.override.yaml; do
  [ -f "$bundle/$path" ] || die "Release bundle is missing $path"
  mkdir -p "$INSTALL_DIRECTORY/$(dirname "$path")"
  cp "$bundle/$path" "$INSTALL_DIRECTORY/$path"
done
chmod 755 "$INSTALL_DIRECTORY/scenelith"
rm -rf "$temporary"
trap - 0 HUP INT TERM

printf 'Installed the verified release files in %s\n' "$INSTALL_DIRECTORY"
cd "$INSTALL_DIRECTORY"
exec ./scenelith install
