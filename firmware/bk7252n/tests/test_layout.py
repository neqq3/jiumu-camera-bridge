"""Parser/budget regression checks; fixture bytes are not firmware."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("check_layout", Path(__file__).parents[1] / "check_layout.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)


class LayoutTests(unittest.TestCase):
    @staticmethod
    def raw(size=0xc08):
        return bytes.fromhex("0e0000ea") + bytes(size - 4)

    def report(self, **overrides):
        args = {
            "zero_symbols": "00000000 T _vector_start\n00000040 T boot_reset\n",
            "app_symbols": "00010000 T _vector_start\n00010040 T boot_reset\n",
            "zero_map": "flash 0x00000000 0x00200000 xr\n.vectors 0x00000000 0x00000c08\n",
            "app_map": "flash 0x00010000 0x001de000 xr\n.vectors 0x00010000 0x00000c08\n",
            "raw": self.raw(), "rederived": self.raw(),
        }
        args.update(overrides)
        return layout.validate(**args)

    def test_expected_pair_has_explicit_limits(self):
        result = self.report()
        self.assertTrue(result["ok"])
        self.assertFalse(result["safe_to_flash"])
        self.assertFalse(result["installed_boot_contract_verified"])
        self.assertEqual(result["reference_raw_budget"], 0x110000 - 96)

    def test_zero_linked_app_rejected(self):
        self.assertFalse(self.report(app_symbols="00000000 T _vector_start\n00000040 T boot_reset\n")["ok"])

    def test_crc_or_combined_bytes_rejected(self):
        self.assertFalse(self.report(raw=b"synthetic-crc")["ok"])

    def test_budget_reserves_loader_header(self):
        maximum = self.raw(0x110000 - 96)
        self.assertTrue(self.report(raw=maximum, rederived=maximum)["ok"])
        too_large = maximum + b"x"
        self.assertFalse(self.report(raw=too_large, rederived=too_large)["ok"])

    def test_short_or_wrong_reset_branch_rejected(self):
        self.assertFalse(self.report(raw=b"x", rederived=b"x")["ok"])
        wrong = bytes.fromhex("000000ea") + self.raw()[4:]
        self.assertFalse(self.report(raw=wrong, rederived=wrong)["ok"])

    def test_missing_or_duplicate_metadata_rejected(self):
        self.assertFalse(self.report(app_map="")["ok"])
        self.assertFalse(self.report(app_symbols="00010000 T _vector_start\n00010000 T _vector_start\n")["ok"])
        self.assertFalse(self.report(raw=b"", rederived=b"")["ok"])


if __name__ == "__main__":
    unittest.main()
