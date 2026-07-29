#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
manifest="${script_dir}/repositories.json"
requested_ids=("$@")
checkout_root="$(cd -- "${repo_root}/references" && pwd -P)/checkouts"

is_requested() {
  local candidate="$1"
  local requested

  if (( ${#requested_ids[@]} == 0 )); then
    return 0
  fi

  for requested in "${requested_ids[@]}"; do
    if [[ "${candidate}" == "${requested}" ]]; then
      return 0
    fi
  done

  return 1
}

hydrate_one() {
  local id="$1"
  local clone_url="$2"
  local checkout_path="$3"
  local revision="$4"
  local target="${repo_root}/${checkout_path}"
  local target_parent
  local resolved_parent
  local resolved_target
  local actual_revision
  local has_checkout_index=0

  if ! is_requested "${id}"; then
    return 0
  fi

  case "${checkout_path}" in
    references/checkouts/open-source/*|references/checkouts/source-available/*|references/checkouts/clean-room/*) ;;
    *)
      echo "Refusing checkout path outside references/checkouts: ${checkout_path}" >&2
      return 1
      ;;
  esac

  case "/${checkout_path}/" in
    */../*|*/./*)
      echo "Refusing non-canonical checkout path: ${checkout_path}" >&2
      return 1
      ;;
  esac

  case "${checkout_path#references/checkouts/}" in
    */*/*|*//*|*/)
      echo "Refusing nested or non-canonical checkout target: ${checkout_path}" >&2
      return 1
      ;;
  esac

  target_parent="$(dirname -- "${target}")"
  mkdir -p -- "${target_parent}"
  resolved_parent="$(cd -- "${target_parent}" && pwd -P)"
  case "${resolved_parent}/" in
    "${checkout_root}/"*) ;;
    *)
      echo "Refusing checkout parent that resolves outside references/checkouts: ${checkout_path}" >&2
      return 1
      ;;
  esac

  if [[ -L "${target}" ]]; then
    echo "Refusing symlink checkout target: ${target}" >&2
    return 1
  fi

  if [[ -e "${target}" ]]; then
    resolved_target="$(cd -- "${target}" && pwd -P)"
    case "${resolved_target}/" in
      "${checkout_root}/"*) ;;
      *)
        echo "Refusing checkout target that resolves outside references/checkouts: ${checkout_path}" >&2
        return 1
        ;;
    esac
  fi

  if [[ -e "${target}" && ! -d "${target}/.git" ]]; then
    echo "Refusing non-Git checkout target: ${target}" >&2
    return 1
  fi

  if [[ ! -d "${target}/.git" ]]; then
    git clone \
      -c core.hooksPath=/dev/null \
      -c submodule.recurse=false \
      --filter=blob:none \
      --depth=1 \
      --no-tags \
      --no-recurse-submodules \
      --no-checkout \
      "${clone_url}" \
      "${target}"
  fi

  git -C "${target}" config core.hooksPath /dev/null
  git -C "${target}" config fetch.recurseSubmodules false
  git -C "${target}" config submodule.recurse false
  git -C "${target}" config remote.origin.tagOpt --no-tags

  if [[ -f "${target}/.git/index" ]]; then
    has_checkout_index=1
  fi

  if (( has_checkout_index == 1 )) &&
    [[ -n "$(git -C "${target}" status --porcelain --untracked-files=all)" ]]; then
    echo "Refusing to replace a dirty reference checkout: ${target}" >&2
    return 1
  fi

  if ! git -C "${target}" cat-file -e "${revision}^{commit}" 2>/dev/null; then
    git -C "${target}" fetch --depth=1 --no-tags origin "${revision}"
  fi

  git -C "${target}" -c advice.detachedHead=false checkout --detach "${revision}"
  actual_revision="$(git -C "${target}" rev-parse HEAD)"

  if [[ "${actual_revision}" != "${revision}" ]]; then
    echo "Revision mismatch for ${id}: ${actual_revision}" >&2
    return 1
  fi

  # The operator approved these pinned trees for inert reference study. On
  # macOS, remove only Gatekeeper's quarantine marker so opening a text file
  # does not trigger a false download warning. Preserve provenance metadata,
  # keep hooks disabled, and never execute checkout content.
  if command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "${target}" 2>/dev/null || true
  fi

  echo "Hydrated ${id} at ${actual_revision}"
}

while IFS=$'\t' read -r id clone_url checkout_path revision; do
  hydrate_one "${id}" "${clone_url}" "${checkout_path}" "${revision}"
done < <(
  jq -r \
    '.repositories[] | [.id, .cloneUrl, .checkoutPath, .revision] | @tsv' \
    "${manifest}"
)

if (( ${#requested_ids[@]} > 0 )); then
  for requested in "${requested_ids[@]}"; do
    if ! jq -e --arg id "${requested}" \
      '.repositories[] | select(.id == $id)' "${manifest}" >/dev/null; then
      echo "Unknown reference id: ${requested}" >&2
      exit 1
    fi
  done
fi
