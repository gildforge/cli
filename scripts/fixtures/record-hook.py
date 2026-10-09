#!/usr/bin/env python3
import sys,json,pathlib
label=sys.argv[1]; target=pathlib.Path(sys.argv[2])
raw=json.load(sys.stdin)
with target.open('a') as f: f.write(json.dumps({'source':label,'payload':raw})+'\n')
