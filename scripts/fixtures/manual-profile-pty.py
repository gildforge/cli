"""Run only our fixture CLI PID through a real terminal, no provider calls."""
import errno,json,os,pty,select,signal,subprocess,sys,time
args=json.loads(sys.argv[1]); cwd=sys.argv[2]
master,slave=pty.openpty()
p=subprocess.Popen(args,stdin=slave,stdout=slave,stderr=slave,cwd=cwd,env=os.environ,start_new_session=True)
out=b''
try:
    end=time.monotonic()+15
    while time.monotonic()<end:
        if select.select([master],[],[],.1)[0]:
            try: out+=os.read(master,65536)
            except OSError as e:
                if e.errno!=errno.EIO: raise
                break
        if p.poll() is not None: break
    code=p.wait(timeout=2)
    print(json.dumps({'code':code,'output':out.decode(errors='replace')}))
finally:
    if p.poll() is None:
        p.send_signal(signal.SIGTERM)
        try:p.wait(timeout=3)
        except subprocess.TimeoutExpired:p.kill();p.wait()
    os.close(master);os.close(slave)
