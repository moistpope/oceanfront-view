#!/usr/bin/env bash
# Cut a release of the Android app: bump its version, test, build the APK, commit and tag.
#
#   tools/release.sh [minor|patch|major|X.Y[.Z]] [--publish]
#
# The app updates itself from the repository's latest GitHub release (AppUpdater), and offers a release only
# when its tag is a higher version than the installed versionName; after installing, it checks versionCode
# went up. So every release bumps both, in android/app/build.gradle.kts: versionName to the new version (the
# tag is v<versionName>), versionCode by one. The bump defaults to minor (1.0 -> 1.1).
#
# It needs a clean checkout (untracked files are fine) and the same signing key as the APKs already on cars
# (release builds use the debug key: ~/.android/debug.keystore of the machine that built them), or Android
# won't install the update over the app: the APK's signer is checked against SIGNER (the key v1.0 was signed
# with) before anything is committed or tagged.
#
# Without --publish it stops after the commit and tag, and prints how to push and publish. With --publish it
# pushes the commit and the tag and creates the GitHub release with the APK attached (gh).
set -euo pipefail

SIGNER=a9077d92e8b07112b1d966453ba711000c35cb37451b57eb326f804fa472f68d   # SHA-256 of the cars' APKs' certificate

root=$(cd "$(dirname "$0")/.." && pwd)
gradle_file="$root/android/app/build.gradle.kts"
bump=minor
publish=0
for a in "$@"; do
  case "$a" in
    --publish) publish=1 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) bump=$a ;;
  esac
done

die() { echo "release: $*" >&2; exit 1; }
cd "$root"

[ -z "$(git status --porcelain --untracked-files=no)" ] || die "the checkout has uncommitted changes: commit or stash them first"
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
[ "$branch" = master ] || echo "release: note: on '${branch:-a detached HEAD}', not master"

old_name=$(sed -nE 's/^ *versionName = "([^"]+)".*/\1/p' "$gradle_file")
old_code=$(sed -nE 's/^ *versionCode = ([0-9]+).*/\1/p' "$gradle_file")
[ -n "$old_name" ] && [ -n "$old_code" ] || die "can't find versionName/versionCode in $gradle_file"

IFS=. read -r major minor patch <<<"$old_name"
major=${major:-0} minor=${minor:-0} patch=${patch:-0}
case "$bump" in
  major) new_name="$((major + 1)).0" ;;
  minor) new_name="$major.$((minor + 1))" ;;
  patch) new_name="$major.$minor.$((patch + 1))" ;;
  [0-9]*) new_name=$bump ;;
  *) die "unknown bump '$bump': minor, patch, major or a version like 1.4" ;;
esac
[[ "$new_name" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]] || die "'$new_name' isn't a version like 1.4 or 1.4.1"
newest=$(printf '%s\n%s\n' "$old_name" "$new_name" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
[ "$new_name" != "$old_name" ] && [ "$newest" = "$new_name" ] || die "$new_name isn't higher than the current $old_name"
new_code=$((old_code + 1))
tag="v$new_name"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "the tag $tag already exists"

echo "release: $old_name ($old_code) -> $new_name ($new_code), tag $tag"
perl -pi -e "s/^( *versionCode = )\\d+/\${1}$new_code/; s/^( *versionName = )\"[^\"]+\"/\${1}\"$new_name\"/" "$gradle_file"
restore() { git checkout -- "$gradle_file"; echo "release: failed; the version is back at $old_name ($old_code)" >&2; }
trap restore ERR

npm test --silent
(cd android && ./gradlew --quiet testDebugUnitTest assembleRelease)

apk_src=android/app/build/outputs/apk/release/app-release.apk
apk="android/app/build/outputs/apk/release/oceanscape-$tag.apk"
cp "$apk_src" "$apk"
apksigner=$(ls -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}"/build-tools/*/apksigner 2>/dev/null | sort | tail -1 || true)
if [ -n "$apksigner" ]; then
  signer=$("$apksigner" verify --print-certs "$apk" 2>/dev/null | sed -nE 's/.*certificate SHA-256 digest: //p' | head -1)
  if [ "$signer" != "$SIGNER" ]; then
    restore
    die "the APK is signed by ${signer:-an unknown key}, not the cars' key $SIGNER: build it on the machine with that ~/.android/debug.keystore"
  fi
  echo "release: signed with the cars' key"
else
  echo "release: note: no apksigner in the Android SDK's build-tools, so the signing key wasn't checked"
fi

git commit --quiet -m "Oceanscape $tag" -- "$gradle_file"
git tag -a "$tag" -m "Oceanscape $tag"
trap - ERR
echo "release: committed and tagged $tag; the APK is $apk ($(du -h "$apk" | cut -f1 | tr -d ' '))"

if [ "$publish" = 1 ]; then
  git push origin HEAD "refs/tags/$tag"
  gh release create "$tag" "$apk" --title "Oceanscape $tag" --generate-notes
else
  echo "release: to publish it:"
  echo "  git push origin HEAD refs/tags/$tag"
  echo "  gh release create $tag $apk --title \"Oceanscape $tag\" --generate-notes"
fi
