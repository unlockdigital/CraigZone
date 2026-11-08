#!/usr/bin/env python3
"""Run the portable, dependency-free Craig Zone checks."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
checks = [['node', name] for name in ('test-core.cjs','test-content.cjs','test-diagnostics.cjs','test-diagnostics-races.cjs','test-diagnostics-metadata.cjs','chromium/test-compat.cjs')]
checks.append([sys.executable, 'chromium/test-build.py'])
for command in checks:
    subprocess.run(command, cwd=root, check=True)
print('Portable controller, player, diagnostics, compatibility and build checks passed.')
