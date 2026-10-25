#!/usr/bin/env python3
"""Compare and publish private route metadata under a shared writer lock."""
import fcntl
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


def main():
    request = json.load(sys.stdin)
    path = Path(request['file'])
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = os.open(str(path) + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(lock).st_mode):
            raise ValueError('Invalid route lock')
        os.fchmod(lock, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        if 'expected' in request and (not path.exists() or path.read_bytes().decode('utf-8') != request['expected']):
            print('changed')
            return
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as output:
                temporary = output.name
                os.fchmod(output.fileno(), 0o600)
                output.write(request['content'])
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
        print('committed')
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Route publication failed', file=sys.stderr)
        sys.exit(1)
