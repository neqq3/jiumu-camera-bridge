"""Check compile-only image identity and a REFERENCE loader's app budget.

This does not inspect a device or build an OTA package. The SDK emits both a
zero-linked image and an application linked at 0x10000. Only its independently
re-derived, non-CRC application bytes are checked against the reference budget.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re

APP_BASE = 0x10000
REFERENCE_APP_BYTES = 0x110000
APP_HEADER_BYTES = 96


def symbol_address(text: str, name: str) -> int:
    found = re.findall(r"^([0-9a-fA-F]+)\s+[A-Za-z]\s+" + re.escape(name) + r"$", text, re.M)
    if len(found) != 1:
        raise ValueError(f"missing or duplicate symbol: {name}")
    return int(found[0], 16)


def map_origin(text: str) -> int:
    found = re.findall(r"^flash\s+0x([0-9a-fA-F]+)\s+0x[0-9a-fA-F]+\s", text, re.M)
    if len(found) != 1:
        raise ValueError("missing or duplicate flash memory region")
    return int(found[0], 16)


def map_vectors(text: str) -> tuple[int, int]:
    found = re.findall(r"^\.vectors\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s*$", text, re.M)
    if len(found) != 1:
        raise ValueError("missing or duplicate vectors section")
    return tuple(int(n, 16) for n in found[0])


def validate(zero_symbols: str, app_symbols: str, zero_map: str, app_map: str,
             raw: bytes, rederived: bytes) -> dict:
    errors = []
    app_vectors_size = None
    app_reset = None
    for label, symbols, mapping, expected in (
        ("bk7252n.elf", zero_symbols, zero_map, 0),
        ("bk7231_bsp.elf", app_symbols, app_map, APP_BASE),
    ):
        try:
            entry = symbol_address(symbols, "_vector_start")
            reset = symbol_address(symbols, "boot_reset")
            vectors, size = map_vectors(mapping)
            if expected == APP_BASE:
                app_vectors_size, app_reset = size, reset
            if entry != expected or map_origin(mapping) != expected or vectors != expected:
                errors.append(f"{label}: unexpected logical origin/vector address")
            if size < 64 or not expected <= reset < expected + size:
                errors.append(f"{label}: reset handler outside vector/startup section")
        except ValueError as exc:
            errors.append(f"{label}: {exc}")
    if not raw:
        errors.append("raw application is empty")
    if app_vectors_size is not None and len(raw) < app_vectors_size:
        errors.append("raw application is shorter than its vector/startup section")
    if len(raw) >= 4 and app_reset is not None:
        instruction = int.from_bytes(raw[:4], "little")
        immediate = instruction & 0xffffff
        if immediate & 0x800000:
            immediate -= 1 << 24
        if instruction >> 24 != 0xea or APP_BASE + 8 + immediate * 4 != app_reset:
            errors.append("raw application reset branch does not target the linked boot_reset")
    if raw != rederived:
        errors.append("bsp.bin differs from fresh objcopy of bk7231_bsp.elf; possible CRC/combined-image mix-up")
    budget = REFERENCE_APP_BYTES - APP_HEADER_BYTES
    if len(raw) > budget:
        errors.append("raw application exceeds reference app partition minus 96-byte installed header")
    return {
        "schema": 1,
        "ok": not errors,
        "errors": errors,
        "application_elf": "bk7231_bsp.elf",
        "application_raw": "bsp.bin",
        "logical_application_base": APP_BASE,
        "raw_bytes": len(raw),
        "raw_sha256": hashlib.sha256(raw).hexdigest(),
        "raw_matches_fresh_elf_objcopy": raw == rederived,
        "reference_app_partition_bytes": REFERENCE_APP_BYTES,
        "reserved_installed_header_bytes": APP_HEADER_BYTES,
        "reference_raw_budget": budget,
        "reference_headroom_bytes": budget - len(raw),
        "other_elf": "bk7252n.elf is linked at zero; not the preserved-loader application",
        "excluded_formats": ["bk7231_bsp.bin (CRC encoded)", "*_QIO.bin (combined bootloader image)", "*_UA.bin"],
        "installed_boot_contract_verified": False,
        "safe_to_flash": False,
        "scope": "compile-only addresses and raw length; no OTA packaging, device access or recovery proof",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--raw", type=Path, required=True)
    parser.add_argument("--rederived", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = validate(
            (args.results / "bk7252n-symbols.txt").read_text(),
            (args.results / "bk7231_bsp-symbols.txt").read_text(),
            (args.results / "bk7252n.map").read_text(),
            (args.results / "bk7231_bsp.map").read_text(),
            args.raw.read_bytes(), args.rederived.read_bytes())
    except OSError as exc:
        report = {"ok": False, "errors": [str(exc)], "safe_to_flash": False}
    (args.results / "application-layout.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
