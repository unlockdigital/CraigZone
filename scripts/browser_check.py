#!/usr/bin/env python3
"""Run synthetic video checks with an ephemeral identity and fresh profile."""
import argparse
import base64
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(); parser.add_argument('browser', type=Path); args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build', root / 'scripts/build.py')
builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)
with tempfile.TemporaryDirectory(prefix='craig-zone-synthetic-identity-') as temporary:
    folder = Path(temporary)
    subprocess.run(['openssl','genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048','-out',str(folder/'test.pem')], check=True, capture_output=True)
    subprocess.run(['openssl','pkey','-in',str(folder/'test.pem'),'-pubout','-outform','DER','-out',str(folder/'test.der')], check=True, capture_output=True)
    public = (folder/'test.der').read_bytes()
    identity = ''.join(chr(ord('a') + int(n, 16)) for n in hashlib.sha256(public).digest()[:16].hex())
    builder.build(folder/'extension',base64.b64encode(public).decode())
    test_env={key:os.environ[key] for key in ('PATH','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','CHROME_DEVEL_SANDBOX','CZ_CHROMIUM_EVIDENCE_DIR') if key in os.environ}
    test_env['HOME']=str(folder)
    subprocess.run(['node',str(root/'tests/test-browser.cjs'),str(args.browser.resolve()),str(folder/'extension'),identity],cwd=root,check=True,timeout=180,env=test_env)
