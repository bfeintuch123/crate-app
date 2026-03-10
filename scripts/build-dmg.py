#!/usr/bin/env python3
"""Build a styled DMG for Crate with proper DS_Store, background, and icon positions."""

import os
import subprocess
import sys
import shutil
import time

# ── Configuration ──────────────────────────────────────────────────────────────
PROJECT    = "/Users/bryantfeintuchclaw/Projects"
APP_PATH   = os.path.join(PROJECT, "dist/mac-arm64/Crate v2.6.2.app")
BG_PATH    = os.path.join(PROJECT, "build/dmg-background.png")
VOL_ICON   = os.path.join(PROJECT, "build/icon.icns")
APP_FOLDER_ICON = os.path.join(PROJECT, "build/ApplicationsFolderIcon.icns")
OUTPUT_DMG = os.path.join(PROJECT, "dist/Crate.v2.6.2-arm64.dmg")
ALIAS_TOOL = "/tmp/create-alias"

VOL_NAME   = "Crate"
WIN_W, WIN_H = 540, 380
ICON_SIZE  = 120
APP_X, APP_Y = 135, 210
APPS_X, APPS_Y = 405, 210
BG_FILENAME = "dmg-background.png"

# ── Helpers ────────────────────────────────────────────────────────────────────
def run(cmd, **kw):
    print(f"  $ {cmd if isinstance(cmd, str) else ' '.join(cmd)}")
    r = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)
    if r.returncode != 0:
        print(f"  STDERR: {r.stderr.strip()}")
    if r.stdout.strip():
        print(f"  {r.stdout.strip()}")
    return r

def detach(mount_point):
    """Force-detach a volume."""
    subprocess.run(f'hdiutil detach "{mount_point}" -force 2>/dev/null',
                   shell=True, capture_output=True)
    time.sleep(1)

# ── Step 1: Create writable DMG ───────────────────────────────────────────────
print("=== Step 1: Create writable DMG ===")

TEMP_DMG = os.path.join(PROJECT, "dist/_temp_rw.dmg")
MOUNT_PT = "/tmp/dmg_build"

# Clean up any previous mount
detach(MOUNT_PT)
for f in [TEMP_DMG, TEMP_DMG + ".sparseimage"]:
    if os.path.exists(f):
        os.remove(f)
if os.path.exists(MOUNT_PT):
    shutil.rmtree(MOUNT_PT, ignore_errors=True)

# Calculate size needed (app size + 50MB padding)
app_size_mb = int(subprocess.check_output(
    f'du -sm "{APP_PATH}" | cut -f1', shell=True).decode().strip())
dmg_size_mb = app_size_mb + 50
print(f"  App size: {app_size_mb}MB, DMG size: {dmg_size_mb}MB")

r = run(f'hdiutil create -size {dmg_size_mb}m -fs HFS+ -volname "{VOL_NAME}" '
        f'-type SPARSE -o "{TEMP_DMG}"')
SPARSE_IMG = TEMP_DMG + ".sparseimage"
if not os.path.exists(SPARSE_IMG):
    SPARSE_IMG = TEMP_DMG

# ── Step 2: Mount and populate ────────────────────────────────────────────────
print("\n=== Step 2: Mount and populate ===")
os.makedirs(MOUNT_PT, exist_ok=True)
r = run(f'hdiutil attach "{SPARSE_IMG}" -mountpoint "{MOUNT_PT}" -nobrowse -noverify')
if r.returncode != 0:
    print("FATAL: Could not mount DMG")
    sys.exit(1)

# Copy app
print("  Copying app...")
run(f'cp -a "{APP_PATH}" "{MOUNT_PT}/"')

# Create Applications as Finder alias (not symlink)
apps_path = os.path.join(MOUNT_PT, "Applications")
if os.path.exists(apps_path) or os.path.islink(apps_path):
    if os.path.islink(apps_path):
        os.remove(apps_path)
    else:
        shutil.rmtree(apps_path, ignore_errors=True)
        if os.path.exists(apps_path):
            os.remove(apps_path)

print("  Creating Applications Finder alias...")
r = run(f'"{ALIAS_TOOL}" "{apps_path}" "{APP_FOLDER_ICON}"')
if r.returncode != 0:
    # Fallback to symlink
    print("  Alias creation failed, falling back to symlink...")
    os.symlink("/Applications", apps_path)

# Copy background image
bg_dir = os.path.join(MOUNT_PT, ".background")
os.makedirs(bg_dir, exist_ok=True)
shutil.copy2(BG_PATH, os.path.join(bg_dir, BG_FILENAME))
print(f"  Copied background to .background/{BG_FILENAME}")

# Copy volume icon
shutil.copy2(VOL_ICON, os.path.join(MOUNT_PT, ".VolumeIcon.icns"))
run(f'SetFile -a C "{MOUNT_PT}"')
print("  Set volume icon")

# ── Step 3: Write DS_Store ─────────────────────────────────────────────────────
print("\n=== Step 3: Write DS_Store ===")

from ds_store import DSStore, DSStoreEntry
from mac_alias import Alias, Bookmark

ds_store_path = os.path.join(MOUNT_PT, ".DS_Store")
if os.path.exists(ds_store_path):
    os.remove(ds_store_path)

# Create alias record for background image
bg_full_path = os.path.join(MOUNT_PT, ".background", BG_FILENAME)
bg_alias_bytes = None
try:
    bg_alias = Alias.for_file(bg_full_path)
    bg_alias_bytes = bg_alias.to_bytes()
    print(f"  Created background alias ({len(bg_alias_bytes)} bytes)")
except Exception as e:
    print(f"  Alias failed: {e}, trying bookmark...")
    try:
        bg_bm = Bookmark.for_file(bg_full_path)
        bg_alias_bytes = bg_bm.to_bytes()
        print(f"  Created background bookmark ({len(bg_alias_bytes)} bytes)")
    except Exception as e2:
        print(f"  WARNING: No background alias/bookmark: {e2}")

# Build DS_Store entries
with DSStore.open(ds_store_path, 'w+') as d:
    # Window settings
    d['.']['bwsp'] = {
        'ShowPathbar': False,
        'ShowSidebar': False,
        'ShowStatusBar': False,
        'ShowTabView': False,
        'ShowToolbar': False,
        'ContainerShowSidebar': False,
        'SidebarWidth': 0,
        'WindowBounds': '{{100, 100}, {' + str(WIN_W) + ', ' + str(WIN_H) + '}}',
    }

    # Icon view settings
    icvp = {
        'viewOptionsVersion': 1,
        'showIconPreview': True,
        'showItemInfo': False,
        'textSize': 12.0,
        'iconSize': float(ICON_SIZE),
        'gridSpacing': 100.0,
        'gridOffsetX': 0.0,
        'gridOffsetY': 0.0,
        'labelOnBottom': True,
        'arrangeBy': 'none',
    }

    if bg_alias_bytes:
        icvp['backgroundType'] = 2  # picture
        icvp['backgroundImageAlias'] = bg_alias_bytes
    else:
        icvp['backgroundType'] = 1  # white
        icvp['backgroundColorRed'] = 1.0
        icvp['backgroundColorGreen'] = 1.0
        icvp['backgroundColorBlue'] = 1.0

    d['.']['icvp'] = icvp

    # vSrn = view style version (not a registered codec, needs tuple)
    d['.']['vSrn'] = ('long', 1)

    # Icon positions
    d['Crate v2.6.2.app']['Iloc'] = (APP_X, APP_Y)
    d['Applications']['Iloc'] = (APPS_X, APPS_Y)

print("  DS_Store written successfully")

# Verify
print("  Verifying DS_Store...")
with DSStore.open(ds_store_path, 'r') as d:
    for entry in d:
        val = repr(entry.value)
        if len(val) > 120:
            val = val[:120] + "..."
        print(f"    {entry.filename}: {entry.code} = {val}")

# ── Step 4: Hide dotfiles ─────────────────────────────────────────────────────
print("\n=== Step 4: Hide dotfiles ===")
for hidden in ['.DS_Store', '.VolumeIcon.icns', '.background', '.fseventsd']:
    p = os.path.join(MOUNT_PT, hidden)
    if os.path.exists(p):
        run(f'SetFile -a V "{p}"')

# ── Step 5: Unmount and convert ───────────────────────────────────────────────
print("\n=== Step 5: Unmount and convert ===")
run('sync')
time.sleep(2)
detach(MOUNT_PT)

if os.path.exists(OUTPUT_DMG):
    os.remove(OUTPUT_DMG)
    print(f"  Removed old {OUTPUT_DMG}")

print("  Converting to compressed DMG...")
r = run(f'hdiutil convert "{SPARSE_IMG}" -format UDZO -imagekey zlib-level=9 '
        f'-o "{OUTPUT_DMG}"')
if r.returncode != 0:
    print(f"FATAL: hdiutil convert failed")
    sys.exit(1)

if os.path.exists(SPARSE_IMG):
    os.remove(SPARSE_IMG)

size_mb = os.path.getsize(OUTPUT_DMG) / 1024 / 1024
print(f"\n=== Done! Output: {OUTPUT_DMG} ({size_mb:.1f} MB) ===")

# ── Step 6: Verify ────────────────────────────────────────────────────────────
print("\n=== Step 6: Verify final DMG ===")
VERIFY_PT = "/tmp/dmg_verify"
detach(VERIFY_PT)
os.makedirs(VERIFY_PT, exist_ok=True)
r = run(f'hdiutil attach "{OUTPUT_DMG}" -mountpoint "{VERIFY_PT}" -nobrowse')
if r.returncode == 0:
    run(f'ls -la "{VERIFY_PT}/"')
    run(f'ls -la "{VERIFY_PT}/.background/"')
    # Check file type of Applications
    run(f'file "{VERIFY_PT}/Applications"')
    try:
        with DSStore.open(os.path.join(VERIFY_PT, ".DS_Store"), 'r') as d:
            print("  DS_Store entries:")
            for entry in d:
                val = repr(entry.value)
                if len(val) > 120:
                    val = val[:120] + "..."
                print(f"    {entry.filename}: {entry.code} = {val}")
    except Exception as e:
        print(f"  Could not read DS_Store: {e}")
    detach(VERIFY_PT)
else:
    print("  Could not mount for verification")
