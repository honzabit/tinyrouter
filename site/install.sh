#!/bin/sh
# TinyRouter installer, served at https://tinyrouter.dev/install.sh
#
#   curl -fsSL https://tinyrouter.dev/install.sh | sh                # latest release
#   curl -fsSL https://tinyrouter.dev/install.sh | sh -s -- 0.9.0    # a specific one
#
# It picks the release archive for this system, checks it against that
# release's SHA256SUMS, and unpacks `tinyrouter` and `tinyrouter.example.yaml`
# into the current directory - the same result as downloading the archive by
# hand. It needs no root and touches nothing else. Set TINYROUTER_INSTALL_DIR
# to unpack somewhere else.
#
# You are about to run a script from the internet, which is the thing this
# project asks you to be careful about. It is short; read it first:
#
#   curl -fsSL https://tinyrouter.dev/install.sh -o install.sh
#   less install.sh && sh install.sh

set -eu

repo="honzabit/tinyrouter"

fail() {
  echo "tinyrouter install: $*" >&2
  exit 1
}

# Everything runs from here, called on the last line. If the download of this
# script is cut short, sh runs nothing rather than the first half of it.
main() {
  version="${1:-${TINYROUTER_VERSION:-latest}}"
  dest="${TINYROUTER_INSTALL_DIR:-.}"

  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "there is no prebuilt executable for $(uname -s). See https://github.com/$repo#install to run from source." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "there is no prebuilt executable for $(uname -m). See https://github.com/$repo#install to run from source." ;;
  esac
  # The glibc build cannot start on musl systems such as Alpine; they get -musl.
  libc=""
  if [ "$os" = linux ] && ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
    libc=-musl
  fi
  # A shell running under Rosetta reports x86_64 on Apple silicon. The native
  # build is the one to install.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi

  case "$version" in
    latest) base="https://github.com/$repo/releases/latest/download" ;;
    v[0-9]*.[0-9]*.[0-9]*) base="https://github.com/$repo/releases/download/$version" ;;
    [0-9]*.[0-9]*.[0-9]*) base="https://github.com/$repo/releases/download/v$version" ;;
    *) fail "'$version' is not a version such as 0.9.0, or 'latest'." ;;
  esac

  archive="tinyrouter-$os-$arch$libc.tar.gz"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading $archive ($version) from github.com/$repo"
  curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "could not download $base/SHA256SUMS"
  # Looked up first: releases up to 0.9.0 have no musl build, which is not a failed download.
  expected="$(awk -v name="$archive" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || [ -z "$libc" ] ||
    fail "the $version release has no musl build; they start after 0.9.0. Use the container image ghcr.io/$repo, or run from source: https://github.com/$repo#quick-start"
  [ -n "$expected" ] || fail "SHA256SUMS lists no checksum for $archive."
  curl -fsSL "$base/$archive" -o "$tmp/$archive" || fail "could not download $base/$archive"

  # Integrity against a corrupted or truncated download. Both files come from
  # the same release, so this says nothing about a release that was itself
  # tampered with.
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$archive" | awk '{ print $1 }')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp/$archive" | awk '{ print $1 }')"
  else
    fail "found neither sha256sum nor shasum, so the download cannot be checked."
  fi
  [ "$actual" = "$expected" ] || fail "$archive does not match its checksum in SHA256SUMS; nothing was installed."

  # The archive holds no tinyrouter.yaml, so an existing configuration is never
  # overwritten. An existing executable is replaced, which is how you upgrade.
  mkdir -p "$dest"
  tar -xzf "$tmp/$archive" -C "$dest"

  # The musl build also needs the C++ runtime, which Alpine leaves out.
  installed="$("$dest/tinyrouter" --version 2>"$tmp/stderr")" || {
    if grep -q 'libstdc++' "$tmp/stderr"; then
      fail "unpacked to $dest, but $dest/tinyrouter needs libstdc++ to start. Install it (on Alpine: apk add libstdc++), then run $dest/tinyrouter --version"
    fi
    fail "unpacked to $dest, but $dest/tinyrouter does not run on this system."
  }
  echo "Installed TinyRouter $installed to $dest"
  if [ ! -e "$dest/tinyrouter.yaml" ]; then
    where=""
    [ "$dest" = . ] || where="in $dest, "
    echo "Next: ${where}copy tinyrouter.example.yaml to tinyrouter.yaml, keep the providers you use, and run ./tinyrouter"
  fi
}

main "$@"
