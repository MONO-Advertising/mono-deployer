#!/usr/bin/env python3
"""Capture an operator-created replacement privately; never print its value."""
import getpass
import json
import os
import pathlib
import sys

fields = {'builder': 'BUILDER_PRIVATE_KEY', 'webhook': 'BUILDER_WEBHOOK_SECRET'}
if len(sys.argv) != 2 or sys.argv[1] not in fields:
    raise SystemExit('Usage: python3 scripts/capture-secret.py builder|webhook')
kind = sys.argv[1]
value = getpass.getpass('Paste the NEW ' + fields[kind] + ' (input is hidden): ').strip()
if len(value) < 24:
    raise SystemExit('Value is too short; nothing saved.')
if kind == 'builder' and not value.startswith('bpk-'):
    raise SystemExit('Expected a Builder Space private key beginning bpk-; nothing saved.')
folder = pathlib.Path(__file__).resolve().parent.parent / '.secrets'
folder.mkdir(mode=0o700, exist_ok=True)
os.chmod(folder, 0o700)
path = folder / (kind + '.json')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump({fields[kind]: value}, f)
os.chmod(path, 0o600)
print('Replacement saved privately to ' + str(path) + '. No provider setting was changed yet.')
