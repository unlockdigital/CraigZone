#!/usr/bin/env python3
"""Run the portable, dependency-free CraigZone checks."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
checks = [['node', name] for name in ('tests/test-core.cjs','tests/test-content.cjs','tests/test-diagnostics.cjs','tests/test-diagnostics-races.cjs','tests/test-diagnostics-metadata.cjs','tests/test-compat.cjs')]
checks.append([sys.executable, 'tests/test-build.py'])
for command in checks:
    subprocess.run(command, cwd=root, check=True)
print('Portable controller, player, diagnostics, compatibility and build checks passed.')
