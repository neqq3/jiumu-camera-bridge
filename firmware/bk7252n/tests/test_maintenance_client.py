"""No network. Protect local files and do not reflect credentials from a peer."""
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
from maintenance_client import clean_response, exclusive


class ClientPrivacy(unittest.TestCase):
    def test_reflective_response_is_not_printable(self):
        reflected = 'Bearer '+'a'*64
        result = clean_response({'error': reflected, 'state': reflected, 'result': reflected,
                                 'authorization': reflected, 'backup_bytes': reflected,
                                 'boot_contract_verified': reflected})
        self.assertEqual(result, {})

    def test_exact_types_and_bounds(self):
        result = clean_response({'state': 'verified', 'result': 'ok',
                                 'received_bytes': True, 'package_bytes': -1,
                                 'backup_bytes': 5*1024*1024, 'reboot_available': True,
                                 'boot_contract_verified': 1, 'header_may_be_valid': False})
        self.assertEqual(result, {'state': 'verified', 'result': 'ok',
                                  'reboot_available': True, 'header_may_be_valid': False})
        with self.assertRaises(ValueError):
            clean_response([])

    def test_existing_private_file_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder)/'token'
            exclusive(path, b'original')
            with self.assertRaises(FileExistsError):
                exclusive(path, b'replacement')
            self.assertEqual(path.read_bytes(), b'original')


if __name__ == '__main__':
    unittest.main()
