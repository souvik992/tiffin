#!/bin/bash
# Builds the iPhone/iPad app for devices (run in ios/ on a Mac, after prepare.ts and `xcodegen generate`):
#   bash scripts/build-device.sh <output folder>
# With the Apple signing secrets in the environment it makes a signed .ipa:
#   CERT_P12_B64   base64 of the distribution (or development) certificate with its private key (.p12)
#   CERT_PASSWORD  the .p12 password
#   PROFILE_B64    base64 of the provisioning profile (.mobileprovision) for com.tiffinpos.pos
#   TEAM_ID        the Apple Developer team id (10 characters)
#   EXPORT_METHOD  ad-hoc (default: phones listed in the profile), app-store-connect (TestFlight / App Store),
#                  development, or enterprise
# Without them it makes an unsigned .ipa (iPhones refuse it until it is signed, e.g. with the same secrets later).
set -euo pipefail
OUT="${1:?output folder}"
mkdir -p "$OUT"
VERSION=$(sed -n 's/^MARKETING_VERSION = //p' Version.xcconfig)

if [ -z "${CERT_P12_B64:-}" ] || [ -z "${PROFILE_B64:-}" ] || [ -z "${TEAM_ID:-}" ]; then
  echo "No signing secrets: building an unsigned .ipa"
  xcodebuild -project TiffinPOS.xcodeproj -scheme TiffinPOS -configuration Release -sdk iphoneos \
    -destination 'generic/platform=iOS' -derivedDataPath build/device CODE_SIGNING_ALLOWED=NO build | grep -E "error:|BUILD (SUCCEEDED|FAILED)" || true
  APP=build/device/Build/Products/Release-iphoneos/TiffinPOS.app
  test -d "$APP"
  rm -rf build/Payload && mkdir -p build/Payload && cp -R "$APP" build/Payload/
  (cd build && zip -qry "$OUT/TiffinPOS-$VERSION-unsigned.ipa" Payload)
  echo "$OUT/TiffinPOS-$VERSION-unsigned.ipa"
  exit 0
fi

KEYCHAIN="$RUNNER_TEMP/pos-signing.keychain-db"
KEYCHAIN_PASSWORD=$(openssl rand -hex 16)
cleanup() { security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true; rm -f "$RUNNER_TEMP/pos-cert.p12" "$RUNNER_TEMP/pos.mobileprovision"; }
trap cleanup EXIT
echo "$CERT_P12_B64" | base64 -d > "$RUNNER_TEMP/pos-cert.p12"
echo "$PROFILE_B64" | base64 -d > "$RUNNER_TEMP/pos.mobileprovision"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$RUNNER_TEMP/pos-cert.p12" -P "$CERT_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN"
security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')

security cms -D -i "$RUNNER_TEMP/pos.mobileprovision" > "$RUNNER_TEMP/profile.plist"
PROFILE_UUID=$(/usr/libexec/PlistBuddy -c 'Print UUID' "$RUNNER_TEMP/profile.plist")
PROFILE_NAME=$(/usr/libexec/PlistBuddy -c 'Print Name' "$RUNNER_TEMP/profile.plist")
mkdir -p "$HOME/Library/MobileDevice/Provisioning Profiles"
cp "$RUNNER_TEMP/pos.mobileprovision" "$HOME/Library/MobileDevice/Provisioning Profiles/$PROFILE_UUID.mobileprovision"
IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN" | sed -n 's/.*"\(.*\)"$/\1/p' | head -1)
METHOD="${EXPORT_METHOD:-ad-hoc}"
echo "Signing as \"$IDENTITY\" with profile \"$PROFILE_NAME\" ($METHOD)"

xcodebuild -project TiffinPOS.xcodeproj -scheme TiffinPOS -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' -archivePath build/TiffinPOS.xcarchive \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_IDENTITY="$IDENTITY" PROVISIONING_PROFILE_SPECIFIER="$PROFILE_NAME" \
  OTHER_CODE_SIGN_FLAGS="--keychain $KEYCHAIN" archive | grep -E "error:|ARCHIVE (SUCCEEDED|FAILED)" || true
test -d build/TiffinPOS.xcarchive

cat > build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>$METHOD</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>provisioningProfiles</key><dict><key>com.tiffinpos.pos</key><string>$PROFILE_NAME</string></dict>
  <key>compileBitcode</key><false/>
  <key>stripSwiftSymbols</key><true/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath build/TiffinPOS.xcarchive -exportOptionsPlist build/ExportOptions.plist -exportPath build/export
mv build/export/*.ipa "$OUT/TiffinPOS-$VERSION.ipa"
echo "$OUT/TiffinPOS-$VERSION.ipa"
