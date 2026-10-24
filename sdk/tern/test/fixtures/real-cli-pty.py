"""Run the real CLI on an owned OS PTY. JSON stdin controls only that PTY."""
import codecs
import errno
import fcntl
import json
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def terminal_state(attributes):
    mask = termios.ICANON | termios.ECHO | termios.ISIG
    return {
        "iflag": attributes[0],
        "oflag": attributes[1],
        "cflag": attributes[2],
        "lflag": attributes[3],
        "cooked": attributes[3] & mask == mask,
    }


def controlling_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def terminate_signal(_number, _frame):
    raise SystemExit(143)


def main():
    if len(sys.argv) < 2:
        raise ValueError("Pass the exact Node binary and CLI arguments")
    master, slave = pty.openpty()
    process = None
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    before = termios.tcgetattr(slave)
    try:
        if not terminal_state(before)["cooked"]:
            raise RuntimeError("Owned PTY did not start in cooked mode")
        process = subprocess.Popen(
            sys.argv[1:], stdin=slave, stdout=slave, stderr=slave,
            preexec_fn=controlling_terminal, close_fds=True,
        )
        emit({"type": "ready", "pid": process.pid, "tty": os.ttyname(slave),
              "stdinIsTTY": os.isatty(slave), "before": terminal_state(before)})
        control = b""
        deadline = time.monotonic() + 75
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError("Real CLI OS-PTY gate exceeded 75 seconds")
            ready, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.05)
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if data:
                    text = decoder.decode(data)
                    if text:
                        emit({"type": "output", "text": text})
            if sys.stdin.fileno() in ready:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    return
                control += data
                while b"\n" in control:
                    line, control = control.split(b"\n", 1)
                    action = json.loads(line)
                    if action.get("type") == "write":
                        data = action["text"].encode("utf-8")
                        while data:
                            written = os.write(master, data)
                            data = data[written:]
                    elif action.get("type") == "terminate":
                        return
                    else:
                        raise ValueError("Unknown owned PTY control action")
            if process.poll() is not None:
                # Keep the slave open until termios is captured after the CLI exits.
                while select.select([master], [], [], 0)[0]:
                    data = os.read(master, 65536)
                    if not data:
                        break
                    text = decoder.decode(data)
                    if text:
                        emit({"type": "output", "text": text})
                tail = decoder.decode(b"", final=True)
                if tail:
                    emit({"type": "output", "text": tail})
                after = termios.tcgetattr(slave)
                emit({"type": "exit", "code": process.returncode,
                      "after": terminal_state(after), "restored": before == after})
                return
    finally:
        if process is not None:
            # The session leader can exit before an fx descendant. Clean only this owned group.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=3)
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, terminate_signal)
    try:
        main()
    except Exception as error:
        emit({"type": "error", "message": str(error)})
        sys.exit(1)
