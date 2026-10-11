import json,os,sys,time
# Test-only launcher: a send takes longer than the harness's eight-second bound.
# If that bound is removed, the command completes and the regression must fail.
command=json.loads(sys.argv[1]);args=sys.argv[2:]
if args==['send','fixture','first']:time.sleep(9)
os.execvp(command[0],command+args)
