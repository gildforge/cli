"""Drive only an owned guarded auth CLI through a real PTY."""
import os,sys,pty,subprocess,json,time,select,errno,signal
command=json.loads(sys.argv[1]);mode=sys.argv[2]
master,slave=pty.openpty()
proc=subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,env=os.environ,start_new_session=True)
os.close(slave);output=b'';device=False;answer=False
try:
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        if select.select([master],[],[],.05)[0]:
            try:output+=os.read(master,65536)
            except OSError as error:
                if error.errno!=errno.EIO:raise
                break
        if not device and b'What should this machine' in output:
            os.write(master,b'\x03' if mode=='cancel' else b'fixture-device\r')
            device=True
        if mode in ['decline','generation-error'] and not answer and b'Understood?' in output:
            os.write(master,b'n\r' if mode=='decline' else b'y\r');answer=True
        if proc.poll() is not None:break
    code=proc.wait(timeout=2)
    assert device and (mode=='cancel' or answer),'Interactive prompt was not reached'
    print(json.dumps({'code':code,'output':output.decode(errors='replace')}))
finally:
    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
        try:proc.wait(timeout=2)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()
    os.close(master)
