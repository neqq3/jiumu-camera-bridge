"""Synthetic RBLs only. A passing test does not model the unknown bootloader."""
import importlib.util, pathlib, unittest, zlib
spec=importlib.util.spec_from_file_location('ota',pathlib.Path(__file__).parents[1]/'ota_preflight.py')
ota=importlib.util.module_from_spec(spec)
spec.loader.exec_module(ota)

def package(part=b'app',algorithm=0x402,raw=1024):
    body=bytes(range(256))*4
    header=ota.HEADER.pack(b'RBL\0',algorithm,0,part,b'test',b'research',zlib.crc32(body),0,raw,len(body),0)
    header=header[:92]+zlib.crc32(header[:92]).to_bytes(4,'little')
    return header+body

class Preflight(unittest.TestCase):
    def test_complete_is_never_flash_approval(self):
        result=ota.inspect(package(),2048,2048)
        self.assertEqual(result['format_checks'],'passed')
        self.assertFalse(result['safe_to_flash'])
    def test_each_interrupted_download_is_rejected(self):
        data=package()
        for end in range(len(data)):
            with self.assertRaises(ValueError): ota.inspect(data[:end])
    def test_corruption(self):
        data=package()
        for i in range(len(data)):
            with self.assertRaises(ValueError): ota.inspect(data[:i]+bytes([data[i]^1])+data[i+1:])
    def test_partition_and_format(self):
        for data in [package(b'bootloader'),package(b'download'),package(b'app',0x102),package(raw=0)]:
            with self.assertRaises(ValueError): ota.inspect(data)
    def test_capacity_and_trailing_data(self):
        for app,staging in [(96,2048),(1100,2048),(2048,1000)]:
            with self.assertRaises(ValueError): ota.inspect(package(),app,staging)
        with self.assertRaises(ValueError): ota.inspect(package()+b'padding')

if __name__=='__main__': unittest.main()
