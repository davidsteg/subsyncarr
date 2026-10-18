#!/usr/bin/env python3
"""Stand-in for alass / ffsubsync in integration tests.

Behaviour is chosen from the subtitle's file name so one run covers every
outcome. Every invocation is appended to $FAKE_ENGINE_LOG.
"""
import os, re, sys, time

engine, args = sys.argv[1], sys.argv[2:]
with open(os.environ["FAKE_ENGINE_LOG"], "a") as log:
    log.write(engine + " " + " ".join(args) + "\n")

if engine == "alass":
    rest = [a for a in args if a != "--no-split"]
    ref, src, out = rest
else:
    ref, src, out = args[0], args[args.index("-i") + 1], args[args.index("-o") + 1]

name = os.path.basename(src)
if "broken" in name:
    sys.stderr.write("could not decode audio\n")
    sys.exit(1)
if "slow" in name:
    time.sleep(60)
if "mismatch" in name:
    shift = 5000 if engine == "alass" else 20000
elif "onesided" in name:
    shift = 0 if engine == "alass" else 20000
elif "insync" in name:
    shift = 20000 if engine == "alass" else 300
elif "settled" in name:
    shift = 100
elif "nearlimit" in name:
    shift = 28000 if engine == "alass" else 60000
elif "wrong" in name:
    shift = 60000
elif "intro" in name:
    shift = None  # only the first cue moves, by a minute
else:
    shift = 1500

def fmt(ms):
    h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"

seen = 0

def move(m):
    global seen
    seen += 1
    t = int(m[1]) * 3600000 + int(m[2]) * 60000 + int(m[3]) * 1000 + int(m[4])
    if shift is None:
        return fmt(t + 60000) if seen <= 2 else fmt(t)
    return fmt(max(0, t + shift))

data = open(src, encoding="utf-8-sig").read()
with open(out, "w") as f:
    f.write(re.sub(r"(\d\d):(\d\d):(\d\d)[,.](\d\d\d)", move, data))
