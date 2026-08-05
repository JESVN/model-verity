#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

REGISTRY="https://registry.npmjs.org"
PACKAGE_SPEC="$(node -p "const p=require('./package.json'); p.name+'@'+p.version")"
NPMRC="$(mktemp /tmp/model-verity-npmrc.XXXXXX)"
umask 077

cleanup() {
  unset NPM_TOKEN
  rm -f "$NPMRC"
}
trap cleanup EXIT INT TERM

printf '%s\n' "First revoke any token previously shared in chat."
printf '%s' "Paste a NEW short-lived granular npm token (input hidden): "
IFS= read -r -s NPM_TOKEN
printf '\n'

if [[ ! "$NPM_TOKEN" =~ ^npm_[A-Za-z0-9]+$ ]]; then
  printf '%s\n' "Invalid npm token format." >&2
  exit 1
fi

printf 'registry=%s/\n//registry.npmjs.org/:_authToken=%s\n' \
  "$REGISTRY" "$NPM_TOKEN" > "$NPMRC"
chmod 600 "$NPMRC"
unset NPM_TOKEN

printf '%s\n' "Publishing $PACKAGE_SPEC to $REGISTRY ..."
NPM_CONFIG_USERCONFIG="$NPMRC" npm publish --access public --registry="$REGISTRY"

printf '%s\n' "Verifying registry metadata ..."
NPM_CONFIG_USERCONFIG="$NPMRC" npm view model-verity name version dist-tags --json --registry="$REGISTRY"
